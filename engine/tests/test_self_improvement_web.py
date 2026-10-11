import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
from test_self_improvement import CONFIG, FakeAPI, feedback, propose

from open_kritt_engine.self_improvement import web
from open_kritt_engine.self_improvement.journal import Journal
from open_kritt_engine.self_improvement.loop import SelfImprovementLoop


@pytest.fixture
def web_controller(tmp_path, monkeypatch):
    api = FakeAPI()
    monkeypatch.setattr(web, "KrittClient", lambda _: api)
    journal_path = tmp_path / "web.sqlite3"
    server = web.ControllerServer(
        ("127.0.0.1", 0), api_url=api.base_url, journal_path=journal_path, token="a" * 64, poll_seconds=0.01
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = f"http://127.0.0.1:{server.server_port}"

    def request(path, body=None, *, token="a" * 64):
        req = Request(
            root + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    yield server, api, request, journal_path
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def test_private_service_requires_authentication_and_rejects_unknown_actions(web_controller):
    _, _, request, _ = web_controller
    assert request("/health", token="")[0] == 200
    assert request("/scans/10/loop", token="wrong")[0] == 401
    assert request("/scans/10/loop")[1] == {"loop": None}
    assert request("/scans/10/loop", {"config": CONFIG, "approved": True})[0] == 409
    assert request("/loops/not-a-uuid/approval", {})[0] == 404


def test_web_enable_is_durable_and_does_not_double_create(web_controller):
    _, api, request, path = web_controller
    status, payload = request("/scans/10/loop", {"config": CONFIG})
    assert status == 201
    lid = payload["loop"]["id"]
    assert request("/scans/10/loop")[1]["loop"]["id"] == lid
    assert request("/scans/10/loop", {"config": CONFIG})[0] == 409
    assert not api.posts
    journal = Journal(path)
    try:
        assert journal.load(lid)["root_scan_id"] == "10"
    finally:
        journal.close()


def test_web_requires_explicit_review_and_matching_digest_before_approval(web_controller):
    _, api, request, path = web_controller
    lid = request("/scans/10/loop", {"config": CONFIG})[1]["loop"]["id"]
    journal = Journal(path)
    try:
        controller = SelfImprovementLoop(api, journal)
        state = propose(controller, api, lid)
        digest = state["runs"][-1]["approval_digest"]
        route = f"/loops/{lid}/approval"
        assert request(route, {"digest": digest, "reviewer": "operator", "reviewed": False})[0] == 409
        assert request(route, {"digest": "0" * 64, "reviewer": "operator", "reviewed": True})[0] == 409
        assert not any(p == "/scans" for p, _ in api.posts)
        status, result = request(route, {"digest": digest, "reviewer": "operator", "reviewed": True})
        assert status == 200 and result["loop"]["state"] == "approved"
        assert result["loop"]["reviews"][0]["source_fingerprint"] == "git:" + "a" * 40
        assert request(f"/loops/{lid}/reviews", {"scan_id": "10", "feedback": feedback()})[0] == 200
        assert request(f"/loops/{lid}/audit")[1]["events"][-1]["kind"] == "review_recorded"
    finally:
        journal.close()


def test_background_worker_progresses_without_a_browser_and_waits_for_approval(web_controller):
    server, api, request, path = web_controller
    lid = request("/scans/10/loop", {"config": CONFIG})[1]["loop"]["id"]
    journal = Journal(path)
    reached = threading.Event()
    original_post = api.post

    def posted(route, body):
        result = original_post(route, body)
        reached.set()
        return result

    api.post = posted
    worker = threading.Thread(target=server.poll, daemon=True)
    worker.start()
    try:
        assert reached.wait(timeout=3)
        server.stopping.set()
        worker.join(timeout=3)
        assert journal.load(lid)["state"] == "waiting_generation"
        assert len(api.posts) == 1
        assert journal.active_ids() == [lid]
        request(f"/loops/{lid}/cancel", {"reason": "Operator cancelled"})
        assert journal.active_ids() == []
    finally:
        server.stopping.set()
        worker.join(timeout=3)
        journal.close()


def test_controller_token_is_private_and_stable(tmp_path):
    path = tmp_path / "auth/token"
    first = web.token_from_file(path)
    assert len(first) == 64
    assert web.token_from_file(path) == first
    assert path.stat().st_mode & 0o777 == 0o600
