import copy
import difflib
import json
import time
import uuid

from .client import SubmissionUnknown, TransientReadError
from .contracts import (
    ImprovementError,
    config_from,
    digest,
    evaluate,
    expand_proposal,
    feedback_from,
    identifier,
    prompt_for,
    require,
    scan_template,
    workflow_snapshot,
)

FINAL_STATES = {"completed", "failed", "cancelled"}


class SelfImprovementLoop:
    """Standalone, durable controller using existing generation/workflow/scan APIs.

    tick() never approves a proposal. Approval is a separate operator action bound
    to the complete expanded workflow and frozen rerun configuration.
    """

    def __init__(self, client, journal):
        self.client = client
        self.journal = journal

    def enable(self, scan_id, config):
        scan_id = identifier(scan_id)
        config = config_from(config)
        scan = self.client.get(f"/scans/{scan_id}")
        require(scan["status"] not in {"failed", "stopped"}, "Choose a completed or still-running baseline scan")
        state = {
            "id": str(uuid.uuid4()),
            "api": self.client.base_url,
            "root_scan_id": scan_id,
            "best_scan_id": scan_id,
            "best_workflow_id": str(scan["workflowId"]),
            "state": "waiting_scan",
            "config": config,
            "template": None,
            "best": None,
            "resources": {},
            "runs": [],
            "reviews": {},
            "pending": None,
        }
        with self.journal.locked():
            self.journal.create(state)
        return state

    def _load(self, loop_id):
        state = self.journal.load(loop_id)
        require(state["api"] == self.client.base_url, "This journal entry belongs to a different backend")
        return state

    def _capture(self, scan_id):
        scan = self.client.get(f"/scans/{identifier(scan_id)}")
        evidence = self.client.get(f"/self-improvement/scans/{scan_id}/evidence")
        findings = self.client.get(f"/scans/{scan_id}/vulnerabilities")
        workflow = workflow_snapshot(self.client.get(f"/workflows/{identifier(scan['workflowId'])}"))
        require(isinstance(findings, list), "Invalid findings response")
        return {"scan": scan, "workflow": workflow, "findings": findings, "evidence": evidence}

    def _resources(self, scan):
        script_ids = {str(scan["postScriptId"])} | {str(p["id"]) for p in scan.get("postScripts", [])}
        paths = [f"/post-scripts/{identifier(i)}" for i in sorted(script_ids)]
        paths += [f"/agent-skills/{identifier(i)}" for i in scan.get("agentSkillIds", [])]
        return {path: self._resource_digest(self.client.get(path)) for path in paths}

    @staticmethod
    def _resource_digest(value):
        return digest({key: value.get(key) for key in ("name", "content", "outputFormat", "slug")})

    def _check_resources(self, state):
        for path, expected in state["resources"].items():
            require(
                self._resource_digest(self.client.get(path)) == expected,
                "A fixed post-script or agent skill changed; start a new comparison",
            )

    @staticmethod
    def _approved_material(state):
        run = state["runs"][-1]
        return {
            "workflow": run["proposal"],
            "scan": run["scan_request"],
            "target_class": state["config"]["target_class"],
        }

    def approve(self, loop_id, approval_digest, reviewer):
        with self.journal.locked():
            state = self._load(loop_id)
            require(state["state"] == "awaiting_approval", "No proposal is awaiting approval")
            require(isinstance(reviewer, str) and reviewer.strip(), "Human reviewer identity is required")
            expected = digest(self._approved_material(state))
            require(
                approval_digest == expected, "Approval digest does not match the current workflow and target settings"
            )
            run = state["runs"][-1]
            run["approval"] = {"digest": expected, "reviewer": reviewer.strip()}
            state["state"] = "approved"
            self.journal.save(state, "human_approved", {"iteration": run["iteration"], **run["approval"]})
            return state

    def review(self, loop_id, scan_id, feedback):
        with self.journal.locked():
            state = self._load(loop_id)
            require(state["state"] not in FINAL_STATES, "This loop is closed")
            scan_id = identifier(scan_id)
            snapshots = (
                [state.get("best")]
                + [r.get("candidate") for r in state["runs"]]
                + [r.get("baseline") for r in state["runs"]]
            )
            snapshot = next((s for s in snapshots if s and str(s["scan"]["id"]) == scan_id), None)
            if snapshot is None and scan_id == state["root_scan_id"]:
                snapshot = self._capture(scan_id)
            require(
                snapshot is not None and snapshot["scan"]["status"] == "completed",
                "Feedback requires a captured completed scan in this loop",
            )
            validated = feedback_from(feedback, snapshot["findings"])
            template = scan_template(snapshot["scan"], snapshot["evidence"])
            if template["repo_kind"] == "remote" and all(d["kind"] == "remote" for d in template["dependencies"]):
                require(
                    validated["target_fingerprint"] == "git:" + template["commit_sha"].lower(),
                    "Feedback fingerprint does not match the pinned scan revision",
                )
            else:
                require(
                    validated["target_fingerprint"].startswith("sha256:"),
                    "Local sources require a SHA-256 fingerprint covering the complete tested source and dependencies",
                )
            state["reviews"][scan_id] = validated
            self.journal.save(state, "review_recorded", {"scan_id": scan_id, "feedback": validated})
            return state

    def cancel(self, loop_id, reason):
        with self.journal.locked():
            state = self._load(loop_id)
            state["state"] = "cancelled"
            state.pop("read_retry", None)
            self.journal.save(
                state,
                "cancelled",
                {"reason": reason, "note": "Existing remote jobs are not cancelled by this controller."},
            )
            return state

    def _submit(self, state, kind, path, body):
        # Persist intent BEFORE a non-idempotent API operation. A crash/timeout
        # leaves a recoverable unknown outcome, never an automatic duplicate POST.
        state["pending"] = {"kind": kind, "path": path, "body": copy.deepcopy(body)}
        state["state"] = "submitting_" + kind
        self.journal.save(state, "submission_intent", state["pending"])
        try:
            result = self.client.post(path, body)
        except SubmissionUnknown as error:
            state["state"] = "submission_unknown"
            self.journal.save(state, "submission_unknown", {"kind": kind, "error": str(error)})
        except ImprovementError as error:
            state["state"] = "failed"
            state["error"] = str(error)
            self.journal.save(state, "submission_rejected", {"kind": kind, "error": str(error)})
        else:
            try:
                self._acknowledge(state, result)
            except (ValueError, KeyError, TypeError) as error:
                state["state"] = "submission_unknown"
                self.journal.save(state, "acknowledgement_invalid", {"kind": kind, "error": str(error)})

    def _acknowledge(self, state, resource):
        pending = state["pending"]
        kind, body = pending["kind"], pending["body"]
        remote_id = identifier(resource["id"])
        run = state["runs"][-1]
        if kind == "generation":
            require(
                resource.get("kind") == "workflow" and resource.get("request") == body["request"],
                "Generation does not match the recorded request",
            )
            for request_key, response_key in (
                ("model", "model"),
                ("model_provider", "modelProvider"),
                ("harness", "harness"),
                ("thinking_effort", "thinkingEffort"),
            ):
                require(resource.get(response_key) == body[request_key], "Generation model selection differs")
            run["generation_id"] = remote_id
            state["state"] = "waiting_generation"
        elif kind == "workflow":
            require(workflow_snapshot(resource) == run["proposal"], "Saved workflow differs from the approved proposal")
            run["workflow_id"] = remote_id
            state["state"] = "workflow_ready"
        else:
            require(str(resource["workflowId"]) == run["workflow_id"], "Rerun uses a different workflow")
            self._check_scan_settings(state, resource, {"jobs": []})
            run["scan_id"] = remote_id
            state["state"] = "waiting_candidate"
        state["pending"] = None
        self.journal.save(state, "submission_acknowledged", {"kind": kind, "remote_id": remote_id})

    def recover(self, loop_id, remote_id):
        with self.journal.locked():
            state = self._load(loop_id)
            require(
                state["state"] == "submission_unknown" or state["state"].startswith("submitting_"),
                "There is no uncertain submission to recover",
            )
            pending = state["pending"]
            resource = self.client.get(pending["path"] + "/" + identifier(remote_id))
            self._acknowledge(state, resource)
            self.journal.save(state, "submission_reconciled", {"remote_id": str(remote_id)})
            return state

    def _check_scan_settings(self, state, scan, evidence):
        run = state["runs"][-1]
        expected = copy.deepcopy(run["scan_request"])
        expected.pop("workflowId")
        expected.pop("expectedWorkflowDigest")
        actual = scan_template(scan, evidence)
        # The backend drops extra values no longer referenced by the new workflow.
        require(set(actual["extra"]) <= set(expected["extra"]), "Rerun introduced new extra inputs")
        expected["extra"] = {k: expected["extra"][k] for k in actual["extra"]}
        require(actual == expected, "Target or runtime settings changed; this rerun is not comparable")

    def _finish_iteration(self, state):
        state["state"] = "completed" if len(state["runs"]) >= state["config"]["max_loops"] else "waiting_scan"
        self.journal.save(
            state,
            "iteration_finished",
            {"iteration": len(state["runs"]), "best_workflow_id": state["best_workflow_id"], "state": state["state"]},
        )

    def tick(self, loop_id):
        with self.journal.locked():
            state = self._load(loop_id)
            if state["state"].startswith("submitting_"):
                state["state"] = "submission_unknown"
                self.journal.save(state, "interrupted_submission", state["pending"])
                return state
            if state["state"] in FINAL_STATES | {"submission_unknown", "awaiting_approval"}:
                return state
            retry = state.get("read_retry")
            if retry and time.time() < retry["next_at"]:
                return state
            try:
                self._tick(state)
            except TransientReadError as error:
                # Reload the last committed checkpoint, discarding partial captures.
                state = self._load(loop_id)
                attempts = state.get("read_retry", {}).get("attempts", 0) + 1
                state["read_retry"] = {
                    "attempts": attempts,
                    "next_at": time.time() + min(60, 5 * 2 ** min(attempts - 1, 4)),
                    "error": str(error),
                }
                self.journal.save(state, "read_retry_scheduled", state["read_retry"])
            except (ImprovementError, ValueError, KeyError, TypeError) as error:
                # Invalid proposals and changed targets fail closed. Full raw drafts
                # are logged before validation, while exceptions expose no credentials.
                state["state"] = "failed"
                state.pop("read_retry", None)
                state["error"] = str(error)
                self.journal.save(state, "failed", {"error": str(error)})
            else:
                if state.pop("read_retry", None) is not None:
                    self.journal.save(state, "read_recovered")
            return state

    def _tick(self, state):
        if state["state"] == "waiting_scan":
            if len(state["runs"]) >= state["config"]["max_loops"]:
                state["state"] = "completed"
                self.journal.save(state, "loop_limit_reached")
                return
            scan = self.client.get(f"/scans/{state['best_scan_id']}")
            require(scan["status"] not in {"failed", "stopped"}, "Baseline scan did not complete")
            if scan["status"] != "completed":
                return
            if state["best"] is None:
                state["best"] = self._capture(state["best_scan_id"])
                state["template"] = scan_template(scan, state["best"]["evidence"])
                state["resources"] = self._resources(scan)
                self.journal.save(
                    state,
                    "baseline_captured",
                    {"workflow": state["best"]["workflow"], "scan_id": state["best_scan_id"]},
                )
            self._check_resources(state)
            baseline = state["best"]
            findings = [
                {k: str(f.get(k, ""))[:240] for k in ("id", "summary", "file_path", "severity", "bountyRank")}
                for f in baseline["findings"][:6]
            ]
            feedback = copy.deepcopy(state["reviews"].get(state["best_scan_id"]))
            if feedback:
                for key in ("findings", "known_misses"):
                    feedback[key] = feedback[key][:4]
                    for item in feedback[key]:
                        item["evidence"] = item["evidence"][:240]
            logs = baseline["evidence"]
            jobs = sorted(logs.get("jobs", []), key=lambda j: not (j.get("error") or j.get("stub")))
            evidence = {
                "status": scan["status"],
                "evaluation_policy": {key: state["config"][key] for key in ("metric", "min_improvement", "max_loops")},
                "counts": {k: scan.get(k) for k in ("findings", "rawCandidates", "duplicateFindings")},
                "sampling_note": "Bounded examples, not exhaustive; complete evidence is retained in the journal.",
                "reviewer_feedback": feedback,
                "finding_examples": findings,
                "job_log_examples": jobs[:4],
                "log_metadata": {k: logs.get(k) for k in ("totalJobs", "truncated", "logSource")},
            }
            previous = [
                {"iteration": r["iteration"], "evaluation": r.get("evaluation"), "failure": r.get("failure")}
                for r in state["runs"]
            ]
            request, markers = prompt_for(baseline["workflow"], evidence, previous)
            iteration = len(state["runs"]) + 1
            request += f"\nController request: {state['id']} iteration {iteration}"
            run = {
                "iteration": iteration,
                "baseline": copy.deepcopy(baseline),
                "markers": markers,
                "request": request,
                "approval": None,
            }
            state["runs"].append(run)
            self._submit(
                state,
                "generation",
                "/generations",
                {"kind": "workflow", "request": request, **state["config"]["improvement_model"]},
            )
            return

        run = state["runs"][-1]
        if state["state"] == "waiting_generation":
            generation = self.client.get(f"/generations/{run['generation_id']}")
            if generation["status"] == "failed":
                run["failure"] = {
                    "generation_error": generation.get("error"),
                    "validation_errors": generation.get("validationErrors"),
                }
                self.journal.save(state, "generation_failed", run["failure"])
                self._finish_iteration(state)
            elif generation["status"] == "completed":
                self.journal.save(
                    state, "raw_proposal_received", {"iteration": run["iteration"], "draft": generation["result"]}
                )
                proposal = expand_proposal(generation["result"], run["markers"], state["template"]["extra"])
                if proposal["levels"] == run["baseline"]["workflow"]["levels"]:
                    state["state"] = "completed"
                    self.journal.save(state, "no_workflow_change", {"analysis": proposal["description"]})
                    return
                proposal["name"] = (
                    f"{run['baseline']['workflow']['name'].split(' [SIL ')[0]} [SIL {state['id'][:8]} r{run['iteration']}]"
                )
                run["proposal"] = proposal
                run["scan_request"] = {
                    **copy.deepcopy(state["template"]),
                    "workflowId": "PROPOSED_WORKFLOW",
                    "expectedWorkflowDigest": digest(proposal),
                }
                run["scan_request"]["configuration"]["self_improvement_lineage"] = {
                    "loop_id": state["id"],
                    "iteration": run["iteration"],
                }
                run["approval_digest"] = digest(self._approved_material(state))
                before = json.dumps(run["baseline"]["workflow"], indent=2, ensure_ascii=False).splitlines(True)
                after = json.dumps(proposal, indent=2, ensure_ascii=False).splitlines(True)
                run["diff"] = "".join(
                    difflib.unified_diff(
                        before, after, fromfile="baseline.workflow.json", tofile="proposed.workflow.json"
                    )
                )
                state["state"] = "awaiting_approval"
                self.journal.save(
                    state,
                    "proposal_ready",
                    {
                        "iteration": run["iteration"],
                        "workflow": proposal,
                        "diff": run["diff"],
                        "analysis": proposal["description"],
                        "approval_digest": run["approval_digest"],
                    },
                )
            return

        if state["state"] in {"approved", "workflow_ready"}:
            require(run.get("approval") is not None, "Human approval is required before any rerun")
            require(run["approval"]["digest"] == digest(self._approved_material(state)), "Approval became stale")
            self._check_resources(state)
            if state["state"] == "approved":
                self._submit(state, "workflow", "/workflows", run["proposal"])
            else:
                saved = workflow_snapshot(self.client.get(f"/workflows/{run['workflow_id']}"))
                require(saved == run["proposal"], "Workflow changed after approval")
                body = {**copy.deepcopy(run["scan_request"]), "workflowId": run["workflow_id"]}
                self._submit(state, "scan", "/scans", body)
            return

        if state["state"] == "waiting_candidate":
            scan = self.client.get(f"/scans/{run['scan_id']}")
            if scan["status"] in {"failed", "stopped"}:
                run["failure"] = self.client.get(f"/self-improvement/scans/{run['scan_id']}/evidence")
                self.journal.save(state, "candidate_failed", run["failure"])
                self._finish_iteration(state)
            elif scan["status"] == "completed":
                candidate = self._capture(run["scan_id"])
                self._check_scan_settings(state, scan, candidate["evidence"])
                require(
                    candidate["workflow"] == run["proposal"], "Candidate workflow differs from the approved version"
                )
                self._check_resources(state)
                run["candidate"] = candidate
                state["state"] = "awaiting_evaluation"
                self.journal.save(state, "candidate_completed", {"scan_id": run["scan_id"]})
            return

        if state["state"] == "awaiting_evaluation":
            before_id = str(run["baseline"]["scan"]["id"])
            before = state["reviews"].get(before_id)
            after = state["reviews"].get(run["scan_id"])
            if before is None or after is None:
                return
            result = evaluate(before, after, state["config"])
            run["evaluation"] = result
            run["evaluation_reviews"] = {"baseline": copy.deepcopy(before), "candidate": copy.deepcopy(after)}
            if result["better"]:
                state["best"] = copy.deepcopy(run["candidate"])
                state["best_scan_id"] = run["scan_id"]
                state["best_workflow_id"] = run["workflow_id"]
            self.journal.save(state, "evaluated", result)
            self._finish_iteration(state)

    def inspect(self, loop_id):
        return self._load(loop_id)

    def export(self, loop_id):
        with self.journal.locked():
            state = self._load(loop_id)
            return {"loop": state, "events": self.journal.events(loop_id)}
