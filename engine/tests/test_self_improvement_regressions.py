import copy
import os
import stat
from contextlib import nullcontext
from http.client import IncompleteRead
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import pytest
from test_self_improvement import CONFIG, FakeAPI, feedback, launch, propose, workflow

from open_kritt_engine.self_improvement import SelfImprovementLoop
from open_kritt_engine.self_improvement import loop as loop_module
from open_kritt_engine.self_improvement.client import KrittClient, SubmissionUnknown, TransientReadError
from open_kritt_engine.self_improvement.contracts import (
    ImprovementError,
    canonical,
    config_from,
    evaluate,
    feedback_from,
)
from open_kritt_engine.self_improvement.journal import Journal
from open_kritt_engine.self_improvement.web import web_view


@pytest.fixture
def running_loop(tmp_path):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    state = controller.enable("10", CONFIG)
    assert controller.tick(state["id"])["state"] == "waiting_generation"
    yield controller, api, journal, state["id"]
    journal.close()


@pytest.mark.parametrize(
    "failure",
    [
        HTTPError("http://test", 503, "Unavailable", {}, None),
        URLError("Disconnected"),
        TimeoutError(),
        IncompleteRead(b"{", 10),
    ],
)
def test_temporary_read_errors_are_retryable_but_post_outcomes_remain_unknown(failure, monkeypatch):
    client = KrittClient()

    def fail(*_, **__):
        raise failure

    monkeypatch.setattr(client.opener, "open", fail)
    with pytest.raises(TransientReadError):
        client.get("/scans/10")
    with pytest.raises(SubmissionUnknown):
        client.post("/scans", {"workflowId": "1"})


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422, 501])
def test_permanent_http_errors_do_not_become_infinite_read_retries(status, monkeypatch):
    client = KrittClient()

    def fail(*_, **__):
        raise HTTPError("http://test", status, "Rejected", {}, None)

    monkeypatch.setattr(client.opener, "open", fail)
    with pytest.raises(ImprovementError) as caught:
        client.get("/scans/10")
    assert not isinstance(caught.value, TransientReadError)


def test_invalid_json_fails_closed_instead_of_retrying_forever(monkeypatch):
    client = KrittClient()
    monkeypatch.setattr(
        client.opener, "open", lambda *_, **__: nullcontext(SimpleNamespace(read=lambda _: b"invalid-json"))
    )
    with pytest.raises(ImprovementError) as caught:
        client.get("/scans/10")
    assert not isinstance(caught.value, TransientReadError)


def test_read_retry_keeps_checkpoint_survives_restart_and_never_repeats_post(running_loop, monkeypatch):
    controller, api, journal, lid = running_loop
    original = api.get
    clock = [1000.0]
    monkeypatch.setattr(loop_module.time, "time", lambda: clock[0])
    reads = []

    def fail(path):
        reads.append(path)
        raise TransientReadError("GET /generations/1 returned HTTP 503")

    monkeypatch.setattr(api, "get", fail)
    state = controller.tick(lid)
    assert state["state"] == "waiting_generation"
    assert state["read_retry"]["next_at"] == 1005
    assert journal.active_ids() == [lid]
    assert web_view(state)["read_retry"]["attempts"] == 1
    controller.tick(lid)
    assert len(reads) == 1
    clock[0] = 1005
    assert controller.tick(lid)["read_retry"]["next_at"] == 1015
    reopened = Journal(journal.path)
    try:
        restarted = SelfImprovementLoop(api, reopened)
        assert restarted.tick(lid)["state"] == "waiting_generation"
        assert len(reads) == 2
        monkeypatch.setattr(api, "get", original)
        clock[0] = 1015
        state = restarted.tick(lid)
        assert state["state"] == "waiting_generation"
        assert "read_retry" not in state
        assert [path for path, _ in api.posts] == ["/generations"]
        assert len(state["runs"]) == 1
        assert reopened.events(lid)[-1]["kind"] == "read_recovered"
    finally:
        reopened.close()


def test_partial_capture_is_discarded_before_read_retry(tmp_path, monkeypatch):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", CONFIG)["id"]
    original = api.get

    def fail(path):
        if path == "/post-scripts/5":
            raise TransientReadError("Connection interrupted")
        return original(path)

    monkeypatch.setattr(api, "get", fail)
    try:
        state = controller.tick(lid)
        assert state["state"] == "waiting_scan"
        assert state["best"] is None
        assert state["template"] is None
        assert state["runs"] == []
        assert api.posts == []
    finally:
        journal.close()


def test_cancel_clears_automatic_retry_notice(running_loop, monkeypatch):
    controller, api, _, lid = running_loop

    def fail(_):
        raise TransientReadError("Connection interrupted")

    monkeypatch.setattr(api, "get", fail)
    assert controller.tick(lid).get("read_retry")
    state = controller.cancel(lid, "Operator cancelled")
    assert state["state"] == "cancelled"
    assert "read_retry" not in state


def test_retry_backoff_is_bounded_and_permanent_failures_stop_retrying(running_loop, monkeypatch):
    controller, api, _, lid = running_loop
    clock = [1000.0]
    monkeypatch.setattr(loop_module.time, "time", lambda: clock[0])

    def temporary(_):
        raise TransientReadError("Connection interrupted")

    monkeypatch.setattr(api, "get", temporary)
    for delay in (5, 10, 20, 40, 60, 60):
        state = controller.tick(lid)
        assert state["read_retry"]["next_at"] - clock[0] == delay
        clock[0] = state["read_retry"]["next_at"]

    def permanent(_):
        raise ImprovementError("GET /generations/1 returned HTTP 404")

    monkeypatch.setattr(api, "get", permanent)
    state = controller.tick(lid)
    assert state["state"] == "failed"
    assert "read_retry" not in state
    assert len(api.posts) == 1


def test_candidate_poll_recovers_without_launching_another_scan(running_loop, monkeypatch):
    controller, api, _, lid = running_loop
    candidate_id = launch(controller, api, lid)
    original = api.get
    clock = [1000.0]
    monkeypatch.setattr(loop_module.time, "time", lambda: clock[0])

    def temporary(_):
        raise TransientReadError("GET candidate returned HTTP 503")

    monkeypatch.setattr(api, "get", temporary)
    assert controller.tick(lid)["state"] == "waiting_candidate"
    monkeypatch.setattr(api, "get", original)
    api.scans[candidate_id]["status"] = "completed"
    clock[0] = 1005
    state = controller.tick(lid)
    assert state["state"] == "awaiting_evaluation"
    assert "read_retry" not in state
    assert [path for path, _ in api.posts].count("/scans") == 1


def test_whitespace_root_cause_duplicates_and_contradictory_misses_are_rejected():
    reviewed = feedback(("1", "2"))
    reviewed["findings"][0]["case_key"] = "authorization-bypass"
    reviewed["findings"][1]["case_key"] = " \tauthorization-bypass\n"
    with pytest.raises(ImprovementError, match="one validated finding"):
        feedback_from(reviewed, [{"id": "1"}, {"id": "2"}])
    reviewed = feedback()
    reviewed["known_misses"] = [{"case_key": " root-cause-1 ", "evidence": "Independent evidence"}]
    with pytest.raises(ImprovementError, match="Contradictory"):
        feedback_from(reviewed, [{"id": "1"}])


def test_root_cause_normalization_preserves_inputs_and_old_reviews_remain_comparable():
    old = feedback()
    old["findings"][0]["case_key"] = " root-cause-1 "
    old["known_misses"] = [{"case_key": "  missed-case  ", "evidence": "Independent evidence"}]
    original = copy.deepcopy(old)
    normalized = feedback_from(old, [{"id": "1"}])
    assert normalized["findings"][0]["case_key"] == "root-cause-1"
    assert normalized["known_misses"][0]["case_key"] == "missed-case"
    assert old == original
    assert evaluate(old, feedback(("1", "2")), config_from(CONFIG))["better"]


@pytest.mark.parametrize(
    "before,after,minimum,better",
    [
        (0.93, 0.94, 0.01, True),
        (0.93, 0.939, 0.01, False),
        (0.94, 0.93, 0.01, False),
        (0.10, 0.11, 0.01, True),
        (0.80, 0.82, 0.02, True),
    ],
)
def test_confidence_threshold_uses_exact_decimal_comparison(before, after, minimum, better):
    baseline, candidate = feedback(), feedback()
    baseline["findings"][0]["confidence"] = before
    candidate["findings"][0]["confidence"] = after
    result = evaluate(baseline, candidate, config_from({**CONFIG, "metric": "confidence", "min_improvement": minimum}))
    assert result["better"] is better
    canonical(result)


def test_multi_finding_confidence_totals_are_compared_without_float_rounding():
    baseline, candidate = feedback(("1", "2")), feedback(("1", "2"))
    baseline["findings"][0]["confidence"] = 0.8
    baseline["findings"][1]["confidence"] = 0.93
    candidate["findings"][0]["confidence"] = 0.8
    candidate["findings"][1]["confidence"] = 0.94
    result = evaluate(baseline, candidate, config_from({**CONFIG, "metric": "confidence", "min_improvement": 0.01}))
    assert result["better"]
    assert result["delta"] == 0.01
    assert result["baseline"]["confidence"] == 1.73
    assert result["candidate"]["confidence"] == 1.74


class TrimmingAPI(FakeAPI):
    def post(self, path, body):
        if path == "/workflows":
            body = copy.deepcopy(body)
            for level in body["levels"]:
                for step in level["steps"]:
                    step["name"] = step["name"].strip()
        return super().post(path, body)


def test_padded_step_names_match_the_saved_workflow_and_rerun(tmp_path):
    api = TrimmingAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", CONFIG)["id"]
    try:
        controller.tick(lid)
        proposal = workflow()
        proposal["levels"][0]["steps"][0]["name"] = " Investigate "
        proposal["levels"][0]["steps"][0]["content"] += "\nCheck authorization boundaries."
        api.generations["1"].update(status="completed", result=proposal)
        state = controller.tick(lid)
        assert state["runs"][0]["proposal"]["levels"][0]["steps"][0]["name"] == "Investigate"
        controller.approve(lid, state["runs"][0]["approval_digest"], "operator")
        assert controller.tick(lid)["state"] == "workflow_ready"
        assert controller.tick(lid)["state"] == "waiting_candidate"
    finally:
        journal.close()


def test_terminal_loops_cannot_be_relabelled_as_cancelled(tmp_path):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", CONFIG)["id"]
    try:
        assert propose(controller, api, lid, modified=False)["state"] == "completed"
        with pytest.raises(ImprovementError, match="closed"):
            controller.cancel(lid, "Late cancellation")
        assert controller.inspect(lid)["state"] == "completed"
    finally:
        journal.close()


def test_existing_journal_permissions_are_made_private(tmp_path):
    path = tmp_path / "journal.sqlite3"
    path.touch()
    os.chmod(path, 0o644)
    Journal(path).close()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
