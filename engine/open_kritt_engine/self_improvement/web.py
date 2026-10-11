"""Private controller service; the backend proxies browser actions with a shared token."""

import argparse
import hmac
import json
import logging
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .client import KrittClient
from .contracts import ImprovementError, identifier, require
from .journal import Journal
from .loop import SelfImprovementLoop

LOGGER = logging.getLogger(__name__)
UUID_PATTERN = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"


def web_view(state):
    run = state["runs"][-1] if state["runs"] else {}
    snapshots = {}
    for snapshot in [state.get("best"), run.get("baseline"), run.get("candidate")]:
        if snapshot:
            scan = snapshot["scan"]
            sid = str(scan["id"])
            revision = (state.get("template") or {}).get("commit_sha", scan["commitSha"])
            snapshots[sid] = {
                "scan_id": sid,
                "workflow_id": str(scan["workflowId"]),
                "source_fingerprint": (
                    "git:" + revision.lower()
                    if scan["repoKind"] == "remote"
                    and re.fullmatch(r"[a-fA-F0-9]{40}", revision)
                    and all(d["kind"] == "remote" for d in scan.get("dependencies", []))
                    else ""
                ),
                "findings": [
                    {k: finding.get(k) for k in ("id", "summary", "file_path", "bountyRank", "bountyRankImpactLevel")}
                    for finding in snapshot["findings"]
                ],
                "feedback": state["reviews"].get(sid),
            }
    return {
        "id": state["id"],
        "root_scan_id": state["root_scan_id"],
        "state": state["state"],
        "error": state.get("error"),
        "config": state["config"],
        "best_scan_id": state["best_scan_id"],
        "best_workflow_id": state["best_workflow_id"],
        "iterations": len(state["runs"]),
        "runs": [
            {
                k: attempt.get(k)
                for k in ("iteration", "generation_id", "workflow_id", "scan_id", "evaluation", "failure", "approval")
            }
            for attempt in state["runs"]
        ],
        "proposal": run.get("proposal"),
        "diff": run.get("diff"),
        "scan_request": run.get("scan_request"),
        "approval_digest": run.get("approval_digest") if state["state"] == "awaiting_approval" else None,
        "pending": {"kind": state["pending"]["kind"]} if state.get("pending") else None,
        "reviews": list(snapshots.values()),
    }


class ControllerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, *, api_url, journal_path, token, poll_seconds=5):
        self.api_url, self.journal_path, self.token = api_url, journal_path, token
        self.poll_seconds = poll_seconds
        self.stopping = threading.Event()
        super().__init__(address, ControllerHandler)

    def poll(self):
        while not self.stopping.is_set():
            try:
                with JournalSession(self) as (controller, journal):
                    for loop_id in journal.active_ids():
                        if self.stopping.is_set():
                            break
                        try:
                            controller.tick(loop_id)
                        except ImprovementError:
                            # A simultaneous browser action owns the journal lock.
                            continue
            except Exception:
                LOGGER.exception("Self-improvement controller poll failed")
            self.stopping.wait(self.poll_seconds)

    def server_close(self):
        self.stopping.set()
        super().server_close()


class JournalSession:
    def __init__(self, server):
        self.server = server

    def __enter__(self):
        self.journal = Journal(self.server.journal_path)
        return SelfImprovementLoop(KrittClient(self.server.api_url), self.journal), self.journal

    def __exit__(self, *_):
        self.journal.close()


class ControllerHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def handle_request(self, method):
        if method == "GET" and self.path == "/health":
            self.reply(200, {"status": "ok"})
            return
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            self.reply(401, {"error": "Controller authentication required"})
            return
        try:
            body = {}
            if method == "POST":
                require(self.headers.get_content_type() == "application/json", "Expected application/json")
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= 2 * 1024 * 1024, "Invalid JSON body size")
                self.connection.settimeout(10)
                body = json.loads(self.rfile.read(length))
                require(isinstance(body, dict), "Expected a JSON object")
            with JournalSession(self.server) as (controller, journal):
                scan_match = re.fullmatch(r"/scans/([1-9][0-9]*)/loop", self.path)
                loop_match = re.fullmatch(
                    rf"/loops/({UUID_PATTERN})(?:/(approval|reviews|cancel|recover|audit))?", self.path
                )
                if scan_match:
                    scan_id = identifier(scan_match[1])
                    if method == "GET":
                        state = journal.for_scan(controller.client.base_url, scan_id)
                        result = {"loop": web_view(state) if state else None}
                    else:
                        require(set(body) == {"config"}, "Only loop configuration is accepted")
                        state = controller.enable(scan_id, body["config"])
                        result = {"loop": web_view(state)}
                    self.reply(200 if method == "GET" else 201, result)
                    return
                if not loop_match:
                    self.reply(404, {"error": "Controller route not found"})
                    return
                loop_id, action = loop_match.groups()
                if method == "GET" and action is None:
                    self.reply(200, {"loop": web_view(controller.inspect(loop_id))})
                    return
                if method == "GET" and action == "audit":
                    self.reply(200, controller.export(loop_id))
                    return
                require(method == "POST", "Unsupported controller action")
                if action == "approval":
                    require(
                        set(body) == {"digest", "reviewer", "reviewed"} and body["reviewed"] is True,
                        "Explicit human review is required",
                    )
                    state = controller.approve(loop_id, body["digest"], body["reviewer"])
                elif action == "reviews":
                    require(set(body) == {"scan_id", "feedback"}, "Invalid review fields")
                    state = controller.review(loop_id, body["scan_id"], body["feedback"])
                elif action == "cancel":
                    require(
                        set(body) == {"reason"} and isinstance(body["reason"], str) and body["reason"].strip(),
                        "Cancellation reason is required",
                    )
                    state = controller.cancel(loop_id, body["reason"])
                elif action == "recover":
                    require(set(body) == {"remote_id"}, "Remote record ID is required")
                    state = controller.recover(loop_id, body["remote_id"])
                else:
                    self.reply(405, {"error": "Unsupported controller action"})
                    return
                self.reply(200, {"loop": web_view(state)})
        except (ImprovementError, ValueError, KeyError, TypeError) as error:
            self.reply(409 if isinstance(error, ImprovementError) else 422, {"error": str(error)})
        except Exception:
            LOGGER.exception("Self-improvement browser action failed")
            self.reply(503, {"error": "Controller is temporarily unavailable"})


def token_from_file(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        token = path.read_text().strip()
    else:
        token = secrets.token_hex(32)
        with os.fdopen(descriptor, "w") as output:
            output.write(token)
    require(bool(re.fullmatch(r"[a-f0-9]{64}", token)), "Invalid controller token file")
    return token


def main():
    parser = argparse.ArgumentParser(description="Private web controller for SelfImprovementLoop")
    parser.add_argument("--api-url", default=os.environ.get("SELF_IMPROVEMENT_API_URL", "http://backend:3002/api"))
    parser.add_argument("--journal", default=os.environ.get("SELF_IMPROVEMENT_JOURNAL", "/state/journal.sqlite3"))
    parser.add_argument("--token-file", default=os.environ.get("SELF_IMPROVEMENT_TOKEN_FILE", "/auth/token"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8091)
    args = parser.parse_args()
    server = ControllerServer(
        (args.host, args.port), api_url=args.api_url, journal_path=args.journal, token=token_from_file(args.token_file)
    )
    worker = threading.Thread(target=server.poll, daemon=True)
    worker.start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        worker.join(timeout=35)


if __name__ == "__main__":
    main()
