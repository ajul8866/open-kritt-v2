import copy
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from open_kritt_engine.generation import REQUIRED_VULN_KEY_TYPES, GenerationValidationError
from open_kritt_engine.self_improvement import SelfImprovementLoop
from open_kritt_engine.self_improvement.client import KrittClient, SubmissionUnknown
from open_kritt_engine.self_improvement.contracts import (
    ImprovementError,
    config_from,
    digest,
    evaluate,
    expand_proposal,
    feedback_from,
    prompt_for,
    scan_template,
    validate_proposal,
    workflow_snapshot,
)
from open_kritt_engine.self_improvement.journal import Journal

SHA = "a" * 40
CONFIG = {
    "max_loops": 1,
    "improvement_model": {
        "model": "test-model",
        "model_provider": "openrouter",
        "harness": "codex",
        "thinking_effort": "high",
    },
}


def workflow():
    return {
        "name": "Baseline",
        "description": "Original workflow",
        "levels": [
            {
                "depth": 0,
                "multiOutput": True,
                "consumesAll": False,
                "outputFormat": dict(REQUIRED_VULN_KEY_TYPES),
                "steps": [{"name": "Investigate", "content": "Inspect {{repo_full}} for evidence-backed bugs."}],
            }
        ],
    }


def baseline_scan():
    return {
        "id": "10",
        "status": "completed",
        "repoKind": "remote",
        "repoFull": "example/project",
        "commitSha": SHA,
        "repoScope": "src/",
        "dependencies": [],
        "workflowId": "1",
        "postScriptId": "5",
        "postScripts": [{"id": "5"}],
        "agentSkillIds": [],
        "configuration": {"repeat_runs": 1, "post_script_ids": ["5"]},
        "model": "test-model",
        "modelProvider": "openrouter",
        "harness": "codex",
        "thinkingEffort": "high",
        "modelOverrides": {},
        "severityRanker": "Independent severity policy",
        "extra": {},
        "jobLimit": 20,
    }


def feedback(ids=("1",), *, verdict="validated", fingerprint="git:" + SHA):
    return {
        "reviewer": "human-reviewer",
        "target_fingerprint": fingerprint,
        "findings": [
            {
                "id": item,
                "verdict": verdict,
                "severity": "high",
                "confidence": 0.9,
                "case_key": f"root-cause-{item}",
                "evidence": "Reproduced with independent control",
            }
            for item in ids
        ],
        "known_misses": [],
    }


class FakeAPI:
    base_url = "http://127.0.0.1:3002/api"

    def __init__(self):
        self.scans = {"10": baseline_scan()}
        self.workflows = {"1": workflow()}
        self.generations = {}
        self.findings = {"10": [{"id": "1", "summary": "Observed bug", "severity": "high"}]}
        self.script = {
            "id": "5",
            "name": "Fixed validator",
            "content": "Check evidence independently",
            "outputFormat": {"verified": "boolean"},
        }
        self.posts = []
        self.uncertain = None

    def get(self, path):
        parts = path.strip("/").split("/")
        if parts[0] == "self-improvement":
            return {
                "scanId": parts[2],
                "jobs": [
                    {
                        "checkedOutCommit": SHA,
                        "status": "completed",
                        "stubExplanation": "No additional supported finding",
                    }
                ],
                "truncated": False,
            }
        if parts[0] == "scans":
            result = self.findings[parts[1]] if len(parts) == 3 else self.scans[parts[1]]
        elif parts[0] == "post-scripts":
            result = self.script
        else:
            result = getattr(self, parts[0])[parts[1]]
        return copy.deepcopy(result)

    def post(self, path, body):
        self.posts.append((path, copy.deepcopy(body)))
        if path == "/generations":
            rid = str(len(self.generations) + 1)
            result = {
                "id": rid,
                "kind": body["kind"],
                "request": body["request"],
                "model": body["model"],
                "modelProvider": body["model_provider"],
                "harness": body["harness"],
                "thinkingEffort": body["thinking_effort"],
                "status": "pending",
            }
            self.generations[rid] = result
        elif path == "/workflows":
            rid = str(len(self.workflows) + 1)
            result = {"id": rid, **copy.deepcopy(body)}
            self.workflows[rid] = result
        elif path == "/scans":
            assert body["expectedWorkflowDigest"] == digest(workflow_snapshot(self.workflows[body["workflowId"]]))
            rid = str(10 + len(self.scans))
            result = {
                **baseline_scan(),
                "id": rid,
                "status": "queued",
                "workflowId": body["workflowId"],
                "configuration": copy.deepcopy(body["configuration"]),
            }
            self.scans[rid] = result
            self.findings[rid] = [{"id": "1"}, {"id": "2"}]
        else:
            raise AssertionError(path)
        if self.uncertain == path:
            self.uncertain = None
            raise SubmissionUnknown("Simulated lost acknowledgement")
        return copy.deepcopy(result)


@pytest.fixture
def setup_loop(tmp_path):
    api = FakeAPI()
    journal = Journal(tmp_path / "journal.sqlite3")
    controller = SelfImprovementLoop(api, journal)
    state = controller.enable("10", CONFIG)
    yield controller, api, journal, state["id"]
    journal.close()


def propose(controller, api, loop_id, *, modified=True):
    state = controller.tick(loop_id)
    run = state["runs"][-1]
    proposal = workflow()
    marker = next(iter(run["markers"]))
    proposal["levels"][0]["steps"][0]["content"] = marker + (
        "\nCheck authorization at alternate entrypoints." if modified else ""
    )
    proposal["description"] = (
        "Analysis: evidence indicates alternate entrypoints need coverage. Change: add a targeted check."
    )
    api.generations[run["generation_id"]].update(status="completed", result=proposal)
    return controller.tick(loop_id)


def launch(controller, api, loop_id):
    state = propose(controller, api, loop_id)
    controller.approve(loop_id, state["runs"][-1]["approval_digest"], "operator")
    assert controller.tick(loop_id)["state"] == "workflow_ready"
    state = controller.tick(loop_id)
    assert state["state"] == "waiting_candidate"
    return state["runs"][-1]["scan_id"]


def test_complete_loop_preserves_versions_and_promotes_only_reviewed_improvement(setup_loop):
    controller, api, journal, lid = setup_loop
    candidate_id = launch(controller, api, lid)
    api.scans[candidate_id]["status"] = "completed"
    assert controller.tick(lid)["state"] == "awaiting_evaluation"
    assert controller.tick(lid)["best_workflow_id"] == "1"
    controller.review(lid, "10", feedback())
    controller.review(lid, candidate_id, feedback(("1", "2")))
    state = controller.tick(lid)
    assert state["state"] == "completed"
    assert state["best_workflow_id"] == "2"
    assert state["runs"][0]["evaluation"]["delta"] == 1
    assert api.workflows["1"] == workflow()
    assert len(api.scans) == 2
    assert "Inspect {{repo_full}}" in api.workflows["2"]["levels"][0]["steps"][0]["content"]
    events = journal.events(lid)
    assert {e["kind"] for e in events} >= {"raw_proposal_received", "proposal_ready", "human_approved", "evaluated"}
    assert next(e for e in events if e["kind"] == "proposal_ready")["payload"]["diff"]
    for _ in range(3):
        controller.tick(lid)
    assert len(api.generations) == 1


def test_model_cannot_run_candidate_without_human_approval(setup_loop):
    controller, api, _, lid = setup_loop
    state = propose(controller, api, lid)
    assert state["state"] == "awaiting_approval"
    for _ in range(3):
        controller.tick(lid)
    assert [path for path, _ in api.posts] == ["/generations"]
    with pytest.raises(ImprovementError, match="digest"):
        controller.approve(lid, "wrong-digest", "operator")
    with pytest.raises(ImprovementError, match="identity"):
        controller.approve(lid, state["runs"][-1]["approval_digest"], "")


def test_stale_approval_and_changed_fixed_validator_fail_closed(setup_loop):
    controller, api, _, lid = setup_loop
    state = propose(controller, api, lid)
    controller.approve(lid, state["runs"][-1]["approval_digest"], "operator")
    api.script["content"] = "Always say verified"
    assert controller.tick(lid)["state"] == "failed"
    assert len(api.scans) == 1


def test_changed_saved_workflow_is_not_launched(setup_loop):
    controller, api, _, lid = setup_loop
    state = propose(controller, api, lid)
    controller.approve(lid, state["runs"][-1]["approval_digest"], "operator")
    controller.tick(lid)
    api.workflows["2"]["levels"][0]["steps"][0]["content"] = "Changed after approval"
    assert controller.tick(lid)["state"] == "failed"
    assert len(api.scans) == 1


def test_changed_approval_material_invalidates_recorded_approval(setup_loop):
    controller, api, journal, lid = setup_loop
    state = propose(controller, api, lid)
    state = controller.approve(lid, state["runs"][-1]["approval_digest"], "operator")
    state["runs"][-1]["scan_request"]["repo_scope"] = "outside-scope/"
    journal.save(state, "test-only-mutation")
    assert controller.tick(lid)["state"] == "failed"
    assert len(api.scans) == 1


@pytest.mark.parametrize("path", ["/generations", "/workflows", "/scans"])
def test_uncertain_post_never_retries_and_can_be_reconciled(setup_loop, path):
    controller, api, _, lid = setup_loop
    if path != "/generations":
        state = propose(controller, api, lid)
        controller.approve(lid, state["runs"][-1]["approval_digest"], "operator")
        if path == "/scans":
            controller.tick(lid)
    api.uncertain = path
    state = controller.tick(lid)
    assert state["state"] == "submission_unknown"
    count = len(api.posts)
    for _ in range(3):
        controller.tick(lid)
    assert len(api.posts) == count
    remote_id = {"/generations": "1", "/workflows": "2", "/scans": "11"}[path]
    recovered = controller.recover(lid, remote_id)
    assert (
        recovered["state"]
        == {"/generations": "waiting_generation", "/workflows": "workflow_ready", "/scans": "waiting_candidate"}[path]
    )
    assert len(api.posts) == count


def test_restart_recovers_durable_state_and_prevents_duplicate_enable(setup_loop):
    controller, api, journal, lid = setup_loop
    state = propose(controller, api, lid)
    reopened = Journal(journal.path)
    try:
        new_controller = SelfImprovementLoop(api, reopened)
        assert new_controller.inspect(lid) == state
        assert new_controller.tick(lid)["state"] == "awaiting_approval"
        with pytest.raises(ImprovementError, match="already has a loop"):
            new_controller.enable("10", CONFIG)
    finally:
        reopened.close()


def test_journal_process_lock_and_append_only_events(setup_loop):
    _, _, journal, lid = setup_loop
    other = Journal(journal.path)
    try:
        with journal.locked(), pytest.raises(ImprovementError, match="Another controller"), other.locked():
            pass
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            journal.db.execute("DELETE FROM events WHERE loop_id = ?", (lid,))
        journal.db.rollback()
    finally:
        other.close()


def test_no_change_stops_and_failed_generation_consumes_loop_budget(setup_loop):
    controller, api, _, lid = setup_loop
    assert propose(controller, api, lid, modified=False)["state"] == "completed"
    assert [p for p, _ in api.posts] == ["/generations"]


def test_generation_failures_stop_at_max_loops(setup_loop):
    controller, api, _, lid = setup_loop
    controller.tick(lid)
    api.generations["1"].update(status="failed", error="Invalid JSON")
    assert controller.tick(lid)["state"] == "completed"
    assert controller.tick(lid)["state"] == "completed"
    assert len(api.generations) == 1


def test_second_iteration_requires_fresh_approval_and_uses_winning_version(setup_loop):
    controller, api, journal, lid = setup_loop
    state = controller.inspect(lid)
    state["config"]["max_loops"] = 2
    journal.save(state, "test-configuration")
    cid = launch(controller, api, lid)
    api.scans[cid]["status"] = "completed"
    controller.tick(lid)
    controller.review(lid, "10", feedback())
    controller.review(lid, cid, feedback(("1", "2")))
    assert controller.tick(lid)["state"] == "waiting_scan"
    state = controller.tick(lid)
    run = state["runs"][-1]
    assert run["baseline"]["scan"]["id"] == cid
    assert run["approval"] is None
    proposal = copy.deepcopy(run["baseline"]["workflow"])
    proposal["levels"][0]["steps"][0]["content"] += "\nCheck rollback controls."
    api.generations["2"].update(status="completed", result=proposal)
    assert controller.tick(lid)["state"] == "awaiting_approval"
    assert len(api.scans) == 2


def test_failed_candidate_cannot_become_best(setup_loop):
    controller, api, _, lid = setup_loop
    cid = launch(controller, api, lid)
    api.scans[cid]["status"] = "failed"
    state = controller.tick(lid)
    assert state["state"] == "completed"
    assert state["best_workflow_id"] == "1"
    assert state["runs"][0]["failure"]


def test_mutated_candidate_runtime_is_not_evaluated(setup_loop):
    controller, api, _, lid = setup_loop
    cid = launch(controller, api, lid)
    api.scans[cid].update(status="completed", model="different-model")
    assert controller.tick(lid)["state"] == "failed"
    assert controller.inspect(lid)["best_workflow_id"] == "1"


def test_invalid_proposal_is_logged_but_never_persisted_or_run(setup_loop):
    controller, api, journal, lid = setup_loop
    controller.tick(lid)
    bad = {**workflow(), "engine_permissions": "unrestricted", "approved": True}
    api.generations["1"].update(status="completed", result=bad)
    assert controller.tick(lid)["state"] == "failed"
    assert any(e["kind"] == "raw_proposal_received" for e in journal.events(lid))
    assert len(api.workflows) == len(api.scans) == 1


def test_running_baseline_waits_and_cancel_never_launches(setup_loop):
    controller, api, _, lid = setup_loop
    api.scans["10"]["status"] = "post_processing"
    assert controller.tick(lid)["state"] == "waiting_scan"
    assert not api.posts
    controller.cancel(lid, "Operator stopped the experiment")
    api.scans["10"]["status"] = "completed"
    assert controller.tick(lid)["state"] == "cancelled"
    assert not api.posts


@pytest.mark.parametrize(
    "change",
    [
        {"max_loops": 0},
        {"max_loops": 11},
        {"max_loops": True},
        {"auto_approve": True},
        {"metric": "raw_finding_count"},
        {"min_improvement": float("nan")},
        {"permissions": "all"},
    ],
)
def test_invalid_configuration_rejected(change):
    with pytest.raises((ImprovementError, GenerationValidationError)):
        config_from({**CONFIG, **change})


def test_large_workflow_keeps_exact_prompts_within_generation_limit():
    original = workflow()
    original["levels"][0]["steps"][0]["content"] = "Preserve all constraints. " * 4000 + "{{repo_full}}"
    request, markers = prompt_for(original, {"findings": []}, [])
    assert len(request.encode("utf-16-le")) // 2 < 20000
    assert '"truncated": true' in request
    proposal = copy.deepcopy(original)
    proposal["levels"][0]["steps"][0]["content"] = next(iter(markers)) + "\nAdd an independent control."
    expanded = expand_proposal(proposal, markers, {})
    assert (
        expanded["levels"][0]["steps"][0]["content"]
        == original["levels"][0]["steps"][0]["content"] + "\nAdd an independent control."
    )


def test_bad_marker_missing_terminal_fields_and_new_extra_rejected():
    bad = workflow()
    bad["levels"][0]["steps"][0]["content"] = "SIL_KEEP_deadbeef"
    with pytest.raises(ImprovementError):
        expand_proposal(bad, {}, {})
    bad = workflow()
    del bad["levels"][0]["outputFormat"]["explanation"]
    with pytest.raises(GenerationValidationError):
        validate_proposal(bad, {})
    bad = workflow()
    bad["levels"][0]["steps"][0]["content"] += "{{extra.secret_token}}"
    with pytest.raises(ImprovementError, match="extra inputs"):
        validate_proposal(bad, {})


def test_unknown_feedback_ids_duplicates_and_unreviewed_findings_rejected():
    for bad in (feedback(("999",)), feedback(("1", "1")), feedback(())):
        with pytest.raises(ImprovementError):
            feedback_from(bad, [{"id": "1"}])


def test_evaluation_rejects_false_positives_lost_cases_and_target_drift():
    config = config_from(CONFIG)
    before = feedback()
    assert evaluate(before, feedback(("1", "2")), config)["better"]
    for after in (feedback(("2", "3")), feedback(("1", "2"), fingerprint="git:" + "b" * 40)):
        assert not evaluate(before, after, config)["better"]
    after = feedback(("1", "2", "3"))
    after["findings"][-1]["verdict"] = "false_positive"
    assert not evaluate(before, after, config)["better"]
    confidence_config = config_from({**CONFIG, "metric": "confidence"})
    after = feedback()
    after["findings"][0]["confidence"] = 0.98
    assert evaluate(before, after, confidence_config)["better"]


def test_unreviewed_model_confidence_never_counts():
    before, after = feedback(), feedback(("1", "2"))
    after["findings"][-1].update(verdict="unverified", confidence=1)
    assert not evaluate(before, after, config_from(CONFIG))["better"]


def test_remote_revision_and_dependencies_are_pinned():
    scan = baseline_scan()
    scan["commitSha"] = "main"
    scan["dependencies"] = [
        {"kind": "remote", "repoFull": "example/dependency", "commitSha": SHA, "display": "dependency"}
    ]
    result = scan_template(scan, {"jobs": [{"checkedOutCommit": SHA}]})
    assert result["commit_sha"] == SHA
    assert result["dependencies"] == [{"kind": "remote", "repo_full": "example/dependency", "commit_sha": SHA}]
    scan["dependencies"][0]["commitSha"] = "HEAD"
    with pytest.raises(ImprovementError, match="dependency"):
        scan_template(scan, {"jobs": [{"checkedOutCommit": SHA}]})


def test_audit_export_contains_both_versions_and_exact_human_approval(setup_loop):
    controller, api, _, lid = setup_loop
    state = propose(controller, api, lid)
    expected = state["runs"][-1]["approval_digest"]
    controller.approve(lid, expected, "alice")
    exported = controller.export(lid)
    assert exported["loop"]["runs"][0]["baseline"]["workflow"] == workflow()
    assert exported["loop"]["runs"][0]["proposal"]["name"] != workflow()["name"]
    approval = next(e for e in exported["events"] if e["kind"] == "human_approved")
    assert approval["payload"]["digest"] == expected
    assert approval["payload"]["reviewer"] == "alice"


def test_invalid_creation_acknowledgement_is_recoverable_without_duplicate(setup_loop, monkeypatch):
    controller, api, _, lid = setup_loop
    original = api.post

    def lose_id(path, body):
        original(path, body)
        return {"status": "pending"}

    monkeypatch.setattr(api, "post", lose_id)
    assert controller.tick(lid)["state"] == "submission_unknown"
    assert controller.tick(lid)["state"] == "submission_unknown"
    assert controller.recover(lid, "1")["state"] == "waiting_generation"
    assert len(api.posts) == 1


def test_local_target_review_requires_complete_source_fingerprint(setup_loop):
    controller, api, _, lid = setup_loop
    api.scans["10"].update(repoKind="local", repoFull="local-project", commitSha="LOCAL")
    controller.tick(lid)
    with pytest.raises(ImprovementError, match="complete tested source"):
        controller.review(lid, "10", feedback())
    controller.review(lid, "10", feedback(fingerprint="sha256:" + "a" * 64))


def test_nonwinning_candidate_keeps_original_best(setup_loop):
    controller, api, _, lid = setup_loop
    cid = launch(controller, api, lid)
    api.scans[cid]["status"] = "completed"
    controller.tick(lid)
    controller.review(lid, "10", feedback())
    reviewed = feedback(("1", "2"))
    reviewed["findings"][1]["verdict"] = "false_positive"
    controller.review(lid, cid, reviewed)
    state = controller.tick(lid)
    assert state["state"] == "completed"
    assert state["best_workflow_id"] == "1"
    assert state["best_scan_id"] == "10"
    assert len(api.workflows) == 2


def test_python_proposal_and_scan_request_match_node_contracts():
    if not shutil.which("node"):
        pytest.skip("Node is required for the backend contract test")
    backend = Path(__file__).resolve().parents[2] / "backend"
    original = workflow()
    original["description"] = "Analisis batas akses 🔍"
    original["levels"][0]["steps"][0]["name"] = "Periksa akses"
    request, markers = prompt_for(original, {}, [])
    proposal = copy.deepcopy(original)
    proposal["levels"][0]["steps"][0]["content"] = next(iter(markers)) + "\nCheck independent evidence."
    proposal = expand_proposal(proposal, markers, {})
    scan = {**scan_template(baseline_scan(), {"jobs": []}), "workflowId": "2"}
    script = """
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateWorkflow, validateScan, validateGeneration } from './src/lib/validation.js';
import { canonicalJson, workflowSnapshot } from './src/lib/improvementEvidence.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
const workflow = validateWorkflow(input.proposal);
let id = 0n;
const steps = workflow.levels.flatMap(level => level.steps.map(step => ({
  ...level, ...step, id: ++id, outputFormat: JSON.stringify(level.outputFormat)
})));
const snapshot = workflowSnapshot(workflow, steps);
const scan = validateScan(input.scan);
validateGeneration(input.generation);
console.log(JSON.stringify({
  snapshot, hash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'),
  repo: scan.repoFull, revision: scan.commitSha, model: scan.model,
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=backend,
        input=json.dumps(
            {
                "proposal": proposal,
                "scan": scan,
                "generation": {"kind": "workflow", "request": request, **CONFIG["improvement_model"]},
            }
        ),
        text=True,
        capture_output=True,
        check=True,
        timeout=15,
    )
    parsed = json.loads(result.stdout)
    assert parsed["snapshot"] == proposal
    assert parsed["hash"] == digest(proposal)
    assert parsed["repo"] == scan["repo_full"]
    assert parsed["revision"] == SHA
    assert parsed["model"] == scan["model"]


@pytest.mark.skipif(
    not os.environ.get("SELF_IMPROVEMENT_TEST_DATABASE_URL"),
    reason="Set SELF_IMPROVEMENT_TEST_DATABASE_URL to a migrated, disposable kritt_loop_test database",
)
def test_loop_through_real_backend_and_postgres(tmp_path):
    import psycopg
    from psycopg.types.json import Jsonb

    database_url = os.environ["SELF_IMPROVEMENT_TEST_DATABASE_URL"]
    assert database_url.rsplit("/", 1)[-1] == "kritt_loop_test", "Use a disposable test database only"
    backend = Path(__file__).resolve().parents[2] / "backend"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        "PATH": os.environ["PATH"],
        "DATABASE_URL": database_url,
        "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "absent-credentials.json"),
        "OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED": "1",
        "LOG_LEVEL": "silent",
    }
    script = f"import {{ createApp }} from './src/app.js'; createApp().listen({port}, '127.0.0.1');"
    with (tmp_path / "backend.log").open("w") as log:
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", script], cwd=backend, env=env, stdout=log, stderr=log
        )
        journal = Journal(tmp_path / "integration.sqlite3")
        try:
            api = KrittClient(f"http://127.0.0.1:{port}/api", timeout=5)
            for _ in range(50):
                try:
                    api.get("/health")
                    break
                except ImprovementError:
                    assert process.poll() is None, (tmp_path / "backend.log").read_text()
                    time.sleep(0.1)
            else:
                pytest.fail("Isolated backend did not start")
            original = api.post("/workflows", workflow())
            post_script = api.post(
                "/post-scripts",
                {
                    "name": "Independent test validator",
                    "description": "Integration fixture",
                    "content": "Verify {{summary}} independently",
                    "outputFormat": {"verified": "boolean"},
                },
            )
            request = {
                **scan_template(baseline_scan(), {"jobs": []}),
                "workflowId": original["id"],
                "postScriptId": post_script["id"],
                "configuration": {},
            }
            baseline = api.post("/scans", request)
            with psycopg.connect(database_url, autocommit=True) as db:
                db.execute("UPDATE public.scans SET status = 'completed' WHERE id = %s", (baseline["id"],))
                controller = SelfImprovementLoop(api, journal)
                state = controller.enable(baseline["id"], CONFIG)
                lid = state["id"]
                state = controller.tick(lid)
                assert state["state"] == "waiting_generation", controller.export(lid)
                controller.review(lid, baseline["id"], feedback(()))
                proposal = workflow()
                proposal["levels"][0]["steps"][0]["content"] += "\nCheck alternate entrypoint authorization."
                db.execute(
                    "UPDATE public.generations SET status = 'completed', result = %s WHERE id = %s",
                    (Jsonb(proposal), state["runs"][0]["generation_id"]),
                )
                state = controller.tick(lid)
                assert state["state"] == "awaiting_approval", controller.export(lid)
                controller.approve(lid, state["runs"][0]["approval_digest"], "integration-reviewer")
                assert controller.tick(lid)["state"] == "workflow_ready", controller.export(lid)
                state = controller.tick(lid)
                assert state["state"] == "waiting_candidate", controller.export(lid)
                candidate_id = state["runs"][0]["scan_id"]
                new_workflow = state["runs"][0]["workflow_id"]
                fid = db.execute(
                    "INSERT INTO workflows.vulnerabilities (scan_id, workflow_id, scan_metadata_id, prev_id, json_answer, dedupe_is_canonical) VALUES (%s, %s, 0, 0, %s, true) RETURNING id",
                    (candidate_id, new_workflow, Jsonb({"summary": "Synthetic integration finding"})),
                ).fetchone()[0]
                db.execute("UPDATE public.scans SET status = 'completed' WHERE id = %s", (candidate_id,))
                assert controller.tick(lid)["state"] == "awaiting_evaluation", controller.export(lid)
                controller.review(lid, candidate_id, feedback((str(fid),)))
                state = controller.tick(lid)
                assert state["state"] == "completed"
                assert state["best_workflow_id"] == new_workflow
                assert workflow_snapshot(api.get(f"/workflows/{original['id']}")) == workflow()
                with pytest.raises(ImprovementError, match="HTTP 422"):
                    api.post("/scans", {**request, "expectedWorkflowDigest": "0" * 64})
        finally:
            journal.close()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
