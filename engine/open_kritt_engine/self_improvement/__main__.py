import argparse
import json
import os
import time
from pathlib import Path

from .client import KrittClient
from .contracts import ImprovementError
from .journal import Journal
from .loop import FINAL_STATES, SelfImprovementLoop

USAGE = """
Run from the engine directory, using its installed Python requirements:
  python -m open_kritt_engine.self_improvement enable SCAN_ID --config examples/self-improvement.json
  python -m open_kritt_engine.self_improvement watch LOOP_ID
  python -m open_kritt_engine.self_improvement export LOOP_ID --output /tmp/loop-review.json
  python -m open_kritt_engine.self_improvement approve LOOP_ID --digest HASH --reviewer YOUR_NAME
  python -m open_kritt_engine.self_improvement review LOOP_ID --scan-id SCAN_ID --feedback feedback.json

Enable is per scan. watch waits for completion, requests analysis, and stops making
changes at awaiting_approval or awaiting_evaluation until the operator acts.
Every iteration, including lab runs, requires a fresh approval of the exported
workflow diff AND scan settings. No model response can supply that approval.

Set max_loops (1..10), improvement_model, metric (validated_high_critical or
confidence), min_improvement and target_class in the config JSON. Rerun scan
models/post-scripts/skills/target settings stay fixed. The improvement model is
only used for analysis. Generation uses the existing sandboxed engine queue.

Review both baseline and candidate with examples/self-improvement-feedback.json.
Review every canonical finding. A case_key identifies one root cause across scans.
Confidence is a reviewer-assigned 0..1 score, summed over distinct validated cases.
Known misses require external evidence; model confidence alone never earns credit.
For local repositories or local dependencies, target_fingerprint must attest a
SHA-256 of ALL reviewed source/dependencies; differing fingerprints prevent promotion.
Remote repositories and dependencies must use pinned Git SHAs. Per-depth model
overrides and bound routing are currently rejected, not silently rewritten.

Journal/export files contain private scan data. Keep the journal outside target
repositories and harness mounts. The new backend evidence endpoint and guarded
scan-create route must be deployed before using this controller. Evidence includes
persisted job errors/status/stubs, not raw harness stdout. The controller is a
separate opt-in process; starting the normal engine alone does not enable it.

On an uncertain POST, recover LOOP_ID --remote-id ID after inspecting the backend.
Never retry an uncertain creation blindly. cancel stops this controller only;
already queued/running remote jobs must be managed through the normal scan UI.
"""


def parser():
    result = argparse.ArgumentParser(
        description="Opt-in SelfImprovementLoop for Open Kritt",
        epilog=USAGE,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument("--api-url", default="http://127.0.0.1:3002/api")
    result.add_argument("--journal", default=str(Path.home() / ".local/state/open-kritt/self-improvement.sqlite3"))
    commands = result.add_subparsers(dest="command", required=True)
    enable = commands.add_parser("enable", help="Enable improvement after one selected scan completes")
    enable.add_argument("scan_id")
    enable.add_argument("--config", required=True)
    for name in ("tick", "status", "watch", "approve", "review", "export", "recover", "cancel"):
        sub = commands.add_parser(name)
        sub.add_argument("loop_id")
        if name == "watch":
            sub.add_argument("--interval", type=int, default=10, choices=range(2, 61), metavar="2..60")
        elif name == "approve":
            sub.add_argument(
                "--digest",
                required=True,
                help="Digest shown by status/export after inspecting the full diff and scan settings",
            )
            sub.add_argument("--reviewer", required=True)
        elif name == "review":
            sub.add_argument("--scan-id", required=True)
            sub.add_argument("--feedback", required=True)
        elif name == "export":
            sub.add_argument("--output", required=True)
        elif name == "recover":
            sub.add_argument("--remote-id", required=True)
        elif name == "cancel":
            sub.add_argument("--reason", required=True)
    return result


def summary(state):
    current = state["runs"][-1] if state["runs"] else {}
    return {
        "loop_id": state["id"],
        "state": state["state"],
        "error": state.get("error"),
        "iterations": len(state["runs"]),
        "max_loops": state["config"]["max_loops"],
        "best_scan_id": state["best_scan_id"],
        "best_workflow_id": state["best_workflow_id"],
        "candidate_scan_id": current.get("scan_id"),
        "approval_digest": current.get("approval_digest") if state["state"] == "awaiting_approval" else None,
        "evaluation": current.get("evaluation"),
    }


def main(argv=None):
    args = parser().parse_args(argv)
    journal = None
    try:
        client = KrittClient(args.api_url)
        journal = Journal(args.journal)
        loop = SelfImprovementLoop(client, journal)
        command = args.command
        if command == "enable":
            state = loop.enable(args.scan_id, json.loads(Path(args.config).read_text()))
        elif command == "approve":
            state = loop.approve(args.loop_id, args.digest, args.reviewer)
        elif command == "review":
            state = loop.review(args.loop_id, args.scan_id, json.loads(Path(args.feedback).read_text()))
        elif command == "recover":
            state = loop.recover(args.loop_id, args.remote_id)
        elif command == "cancel":
            state = loop.cancel(args.loop_id, args.reason)
        elif command == "export":
            text = json.dumps(loop.export(args.loop_id), indent=2, ensure_ascii=False) + "\n"
            descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                output.write(text)
            print(json.dumps({"exported": args.output}))
            return 0
        elif command == "watch":
            previous = None
            while True:
                state = loop.tick(args.loop_id)
                current = json.dumps(summary(state), sort_keys=True)
                if current != previous:
                    print(current, flush=True)
                    previous = current
                if state["state"] in FINAL_STATES | {"submission_unknown"}:
                    return 1 if state["state"] in {"failed", "submission_unknown"} else 0
                time.sleep(args.interval)
        else:
            state = loop.tick(args.loop_id) if command == "tick" else loop.inspect(args.loop_id)
        print(json.dumps(summary(state), indent=2))
        return 1 if state["state"] in {"failed", "submission_unknown"} else 0
    except (ImprovementError, OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        return 1
    except KeyboardInterrupt:
        return 130
    finally:
        if journal is not None:
            journal.close()


if __name__ == "__main__":
    raise SystemExit(main())
