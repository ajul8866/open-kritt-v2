import json

import pytest
from test_self_improvement import CONFIG, FakeAPI, workflow

from open_kritt_engine.generation import GenerationValidationError, validate_generated_artifact
from open_kritt_engine.models import State
from open_kritt_engine.prompting import render_prompt
from open_kritt_engine.queue import _next_states, metadata_key
from open_kritt_engine.self_improvement import SelfImprovementLoop
from open_kritt_engine.self_improvement.contracts import prompt_for, validate_proposal
from open_kritt_engine.self_improvement.handoffs import HandoffValidationError
from open_kritt_engine.self_improvement.journal import Journal
from open_kritt_engine.self_improvement.web import web_view


def chain(*, connected=False, batch=False):
    result = workflow()
    result["levels"].insert(
        0,
        {
            "depth": 0,
            "multiOutput": True,
            "consumesAll": False,
            "outputFormat": {"model_invariant_id": "string", "model_invariant_statement": "string"},
            "steps": [
                {"name": "Infer invariants", "content": "Inspect {{repo_full}} and return evidenced invariants."}
            ],
        },
    )
    step = result["levels"][1]
    step["depth"] = 1
    step["consumesAll"] = batch
    step["steps"][0]["content"] = "Consume the model_invariant_id and model_invariant_statement supplied by depth 0."
    if connected:
        step["steps"][0]["content"] += (
            "\nRecords: {{multi_output_depth_0}}"
            if batch
            else "\nID: {{model_invariant_id}}\nStatement: {{model_invariant_statement}}"
        )
    return result


def test_schema_valid_disconnected_workflow_is_rejected_by_improvement():
    broken = chain()
    validate_generated_artifact("workflow", broken)
    with pytest.raises(HandoffValidationError, match="previous-depth data"):
        validate_proposal(broken, {})


def test_every_sibling_and_every_named_input_must_receive_values():
    broken = chain(connected=True)
    broken["levels"][1]["steps"][0]["content"] = "ID {{model_invariant_id}}; use model_invariant_statement."
    with pytest.raises(HandoffValidationError, match="model_invariant_statement"):
        validate_proposal(broken, {})
    broken = chain(connected=True)
    broken["levels"][1]["steps"].append({"name": "Second consumer", "content": "Inspect {{repo_full}} only."})
    with pytest.raises(HandoffValidationError, match="Second consumer"):
        validate_proposal(broken, {})


def test_batch_handoffs_require_the_collapsed_record_array():
    validate_proposal(chain(connected=True, batch=True), {})
    with pytest.raises(HandoffValidationError, match="multi_output_depth_0"):
        validate_proposal(chain(batch=True), {})
    invalid = chain(connected=True)
    invalid["levels"][1]["consumesAll"] = True
    with pytest.raises(GenerationValidationError):
        validate_proposal(invalid, {})


def test_later_depth_cannot_bypass_its_immediate_predecessor():
    result = chain(connected=True)
    middle = {
        "depth": 1,
        "multiOutput": True,
        "consumesAll": False,
        "outputFormat": {"hyp_id": "string"},
        "steps": [{"name": "Hypothesize", "content": "Use {{model_invariant_id}} and {{model_invariant_statement}}."}],
    }
    result["levels"].insert(1, middle)
    result["levels"][2]["depth"] = 2
    with pytest.raises(HandoffValidationError, match="hyp_id"):
        validate_proposal(result, {})
    result["levels"][2]["steps"][0]["content"] += "\nHypothesis: {{hyp_id}}"
    validate_proposal(result, {})


def test_queue_render_replay_delivers_actual_record_only_with_placeholders():
    payload = {
        "model_invariant_id": "INV-LOCKER-WBTC-SOLVENCY",
        "model_invariant_statement": "Withdrawals preserve solvency.",
    }
    root = State(prev_id=0, prev_table=None, repeat_run=1, context={})
    from types import SimpleNamespace

    parent = SimpleNamespace(id=1, is_last_step=False)
    row = SimpleNamespace(id=13660, json_answer=payload)
    child = _next_states(parent, root, {metadata_key(parent.id, root): [row]})[0]
    broken = render_prompt(chain()["levels"][1]["steps"][0]["content"], child.context)
    fixed = render_prompt(chain(connected=True)["levels"][1]["steps"][0]["content"], child.context)
    assert payload["model_invariant_id"] not in broken
    assert all(value in fixed for value in payload.values())
    validate_proposal(chain(connected=True), {})


def test_model_receives_complete_handoff_diagnostics_even_when_previews_are_truncated():
    original = chain()
    original["levels"][1]["steps"][0]["content"] += "\nPreserve evidence standards. " * 4000
    request, markers = prompt_for(original, {"status": "completed", "findings": []}, [])
    data = json.loads(request.split("UNTRUSTED_INPUT_JSON:\n", 1)[1])
    assert data["baseline_handoff_errors"]
    assert data["handoff_requirements"][0]["missing_named_inputs"] == [
        "model_invariant_id",
        "model_invariant_statement",
    ]
    assert data["handoff_requirements"][0]["references_previous_input"] is False
    assert markers
    assert len(request.encode("utf-16-le")) // 2 < 20000


def test_invalid_model_proposal_retries_with_feedback_but_never_creates_a_scan(tmp_path):
    api = FakeAPI()
    api.workflows["1"] = chain()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", {**CONFIG, "max_loops": 2})["id"]
    try:
        controller.tick(lid)
        api.generations["1"].update(status="completed", result=chain())
        state = controller.tick(lid)
        assert state["state"] == "waiting_scan"
        assert state["runs"][0]["failure"]["kind"] == "invalid_handoff"
        controller.tick(lid)
        assert "invalid_handoff" in api.generations["2"]["request"]
        api.generations["2"].update(status="completed", result=chain(connected=True))
        state = controller.tick(lid)
        assert state["state"] == "awaiting_approval"
        assert state["runs"][1]["approval"] is None
        assert [path for path, _ in api.posts] == ["/generations", "/generations"]
        assert {event["kind"] for event in journal.events(lid)} >= {"raw_proposal_received", "handoff_rejected"}
    finally:
        journal.close()


@pytest.mark.parametrize("phase", ["awaiting_approval", "approved", "workflow_ready", "awaiting_evaluation"])
def test_preexisting_invalid_proposals_cannot_be_approved_launched_or_promoted(tmp_path, phase):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", {**CONFIG, "max_loops": 2})["id"]
    try:
        controller.tick(lid)
        state = controller.inspect(lid)
        run = state["runs"][0]
        run["proposal"] = chain()
        run["candidate"] = {
            "scan": {**api.scans["10"], "id": "11"},
            "workflow": chain(),
            "findings": [],
            "evidence": {},
        }
        state["state"] = phase
        journal.save(state, "legacy_proposal_fixture")
        assert web_view(state)["proposal_validation_errors"]
        if phase == "awaiting_approval":
            from open_kritt_engine.self_improvement.contracts import digest

            run["scan_request"] = {}
            journal.save(state, "legacy_request_fixture")
            with pytest.raises(HandoffValidationError):
                controller.approve(lid, digest(controller._approved_material(state)), "operator")
        state = controller.tick(lid)
        assert state["state"] == "waiting_scan"
        assert state["best_workflow_id"] == "1"
        assert state["runs"][0]["failure"]["kind"] == "invalid_handoff"
        assert [path for path, _ in api.posts] == ["/generations"]
    finally:
        journal.close()


def test_rejected_handoffs_stop_at_the_configured_iteration_budget(tmp_path):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    lid = controller.enable("10", CONFIG)["id"]
    try:
        controller.tick(lid)
        api.generations["1"].update(status="completed", result=chain())
        assert controller.tick(lid)["state"] == "completed"
        controller.tick(lid)
        assert len(api.generations) == 1
        assert len(api.scans) == 1
    finally:
        journal.close()
