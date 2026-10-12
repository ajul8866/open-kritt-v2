"""Contracts for the opt-in controller; model output never supplies scan settings."""

import copy
import hashlib
import json
import math
import re
from decimal import Decimal
from pathlib import Path

from ..generation import validate_generated_artifact, validate_generation_job
from .handoffs import HandoffValidationError, handoff_contracts, validate_handoffs


class ImprovementError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise ImprovementError(message)


def identifier(value):
    require(isinstance(value, (str, int)) and not isinstance(value, bool), "Invalid record ID")
    text = str(value)
    require(bool(re.fullmatch(r"[1-9][0-9]*", text)), "Invalid record ID")
    require(int(text) <= 9_223_372_036_854_775_807, "Record ID is too large")
    return text


def config_from(value):
    require(isinstance(value, dict), "Configuration must be an object")
    allowed = {"max_loops", "improvement_model", "metric", "min_improvement", "target_class"}
    require(not value.keys() - allowed, "Unknown configuration keys")
    loops = value.get("max_loops", 1)
    require(type(loops) is int and 1 <= loops <= 10, "max_loops must be between 1 and 10")
    metric = value.get("metric", "validated_high_critical")
    require(
        isinstance(metric, str) and metric in {"validated_high_critical", "confidence"}, "Unsupported evaluation metric"
    )
    minimum = value.get("min_improvement", 1 if metric == "validated_high_critical" else 0.01)
    require(type(minimum) in (int, float) and math.isfinite(minimum) and minimum > 0, "Invalid min_improvement")
    target_class = value.get("target_class", "production")
    require(isinstance(target_class, str) and target_class in {"production", "bounty", "lab"}, "Invalid target_class")
    model = value.get("improvement_model")
    require(isinstance(model, dict), "improvement_model is required")
    require(not model.keys() - {"model", "model_provider", "harness", "thinking_effort"}, "Unknown model settings")
    selection = validate_generation_job({"kind": "workflow", "request": "configuration validation", **model})
    return {
        "max_loops": loops,
        "metric": metric,
        "min_improvement": minimum,
        "target_class": target_class,
        "improvement_model": {k: selection[k] for k in ("model", "model_provider", "harness", "thinking_effort")},
    }


def workflow_snapshot(value):
    if "levels" in value:
        return copy.deepcopy({key: value[key] for key in ("name", "description", "levels")})
    levels = {}
    for step in sorted(value["steps"], key=lambda s: (s["depth"], int(s["id"]))):
        require(not step.get("boundSourceStepId"), "Bound routing is not supported by workflow generation yet")
        level = levels.setdefault(
            step["depth"],
            {
                "depth": step["depth"],
                "multiOutput": step["multiOutput"],
                "consumesAll": step.get("consumesAll", False),
                "outputFormat": step["outputFormat"],
                "steps": [],
            },
        )
        level["steps"].append({"name": step.get("name") or "", "content": step["content"]})
    return {"name": value["name"], "description": value.get("description") or "", "levels": list(levels.values())}


def validate_proposal(value, available_extra):
    require(
        isinstance(value, dict) and set(value) == {"name", "description", "levels"}, "Only workflow fields are allowed"
    )
    require(isinstance(value["levels"], list) and 1 <= len(value["levels"]) <= 16, "Expected 1 to 16 depths")
    step_count = 0
    for level in value["levels"]:
        require(isinstance(level, dict), "Invalid level")
        require(
            set(level) == {"depth", "multiOutput", "consumesAll", "outputFormat", "steps"},
            "Only supported workflow structure fields are allowed",
        )
        require(isinstance(level["steps"], list), "Invalid steps")
        step_count += len(level["steps"])
        for step in level["steps"]:
            require(
                isinstance(step, dict) and set(step) == {"name", "content"}, "Only step name/content may be supplied"
            )
            require(isinstance(step["content"], str), "Step content must be text")
            refs = re.findall(r"\{\{\s*extra\.([A-Za-z_][A-Za-z0-9_]*)", step["content"])
            require(set(refs) <= set(available_extra), "Proposal requires extra inputs absent from the original scan")
    require(step_count <= 64, "Proposal exceeds 64 steps")
    require(len(canonical(value).encode()) <= 2 * 1024 * 1024, "Proposal exceeds portable workflow size")
    return validate_handoffs(validate_generated_artifact("workflow", value))


def scan_template(scan, evidence):
    revision = scan["commitSha"]
    if scan["repoKind"] == "remote" and not re.fullmatch(r"[a-fA-F0-9]{40}", revision):
        commits = {j["checkedOutCommit"] for j in evidence["jobs"] if j.get("checkedOutCommit")}
        require(len(commits) == 1, "Cannot resolve a unique pinned baseline revision")
        revision = commits.pop()
    if scan["repoKind"] == "remote":
        require(bool(re.fullmatch(r"[a-fA-F0-9]{40}", revision)), "A pinned Git SHA is required for reruns")
    dependencies = []
    for source in scan.get("dependencies", []):
        dep = copy.deepcopy(source)
        require(isinstance(dep, dict), "Structured dependencies are required")
        dep = {
            "kind": dep.get("kind", "remote"),
            "repo_full": dep.get("repoFull", dep.get("repo_full")),
            "commit_sha": dep.get("commitSha", dep.get("commit_sha")),
        }
        if dep.get("kind") == "remote":
            require(
                bool(re.fullmatch(r"[a-fA-F0-9]{40}", dep.get("commit_sha") or "")),
                "Pin dependency revisions before enabling the loop",
            )
        dependencies.append(dep)
    require(
        not scan.get("modelOverrides"),
        "Use a scan without per-depth model overrides so structure changes cannot remap models",
    )
    return {
        "repo_kind": scan["repoKind"],
        "repo_full": scan["repoFull"],
        "commit_sha": revision,
        "repo_scope": scan["repoScope"],
        "dependencies": dependencies,
        "postScriptId": scan["postScriptId"],
        "agentSkillIds": scan.get("agentSkillIds", []),
        "configuration": copy.deepcopy(scan.get("configuration", {})),
        "model": scan["model"],
        "model_provider": scan["modelProvider"],
        "harness": scan["harness"],
        "thinking_effort": scan.get("thinkingEffort") or "medium",
        "severity_ranker": scan.get("severityRanker") or "",
        "extra": copy.deepcopy(scan.get("extra", {})),
        "jobLimit": scan.get("jobLimit"),
        "launchPolicy": "queue",
    }


def feedback_from(value, findings):
    require(isinstance(value, dict), "Feedback must be an object")
    require(set(value) == {"reviewer", "target_fingerprint", "findings", "known_misses"}, "Invalid feedback fields")
    require(isinstance(value["reviewer"], str) and value["reviewer"].strip(), "Reviewer is required")
    require(
        isinstance(value["target_fingerprint"], str)
        and bool(re.fullmatch(r"(?:git:[a-f0-9]{40}|sha256:[a-f0-9]{64})", value["target_fingerprint"])),
        "Supply the Git or complete local-source SHA-256 fingerprint actually reviewed",
    )
    require(isinstance(value["findings"], list) and isinstance(value["known_misses"], list), "Invalid feedback lists")
    value = copy.deepcopy(value)
    expected = {identifier(f["id"]) for f in findings}
    seen, validated_keys = set(), set()
    for item in value["findings"]:
        require(isinstance(item, dict), "Invalid finding review")
        require(
            set(item) == {"id", "verdict", "severity", "confidence", "case_key", "evidence"},
            "Invalid finding review fields",
        )
        fid = identifier(item["id"])
        require(fid in expected and fid not in seen, "Review references an unknown or duplicate finding")
        seen.add(fid)
        require(
            isinstance(item["verdict"], str) and item["verdict"] in {"validated", "false_positive", "unverified"},
            "Invalid verdict",
        )
        require(
            isinstance(item["severity"], str)
            and item["severity"] in {"critical", "high", "medium", "low", "informational"},
            "Invalid severity",
        )
        confidence = item["confidence"]
        require(
            type(confidence) in (int, float) and math.isfinite(confidence) and 0 <= confidence <= 1,
            "Confidence must be between 0 and 1",
        )
        for key in ("case_key", "evidence"):
            require(isinstance(item[key], str) and item[key].strip(), f"{key} is required")
        item["case_key"] = item["case_key"].strip()
        if item["verdict"] == "validated":
            require(item["case_key"] not in validated_keys, "Use one validated finding per root cause")
            validated_keys.add(item["case_key"])
    require(seen == expected, "Review every canonical finding before evaluation")
    missed = set()
    for item in value["known_misses"]:
        require(isinstance(item, dict) and set(item) == {"case_key", "evidence"}, "Invalid known miss")
        require(all(isinstance(v, str) and v.strip() for v in item.values()), "Known misses need evidence")
        item["case_key"] = item["case_key"].strip()
        require(item["case_key"] not in validated_keys | missed, "Contradictory or duplicate known miss")
        missed.add(item["case_key"])
    return value


def evaluate(before, after, config):
    before = feedback_from(before, before["findings"])
    after = feedback_from(after, after["findings"])

    def metrics(review):
        valid = [f for f in review["findings"] if f["verdict"] == "validated"]
        return {
            "validated_high_critical": sum(f["severity"] in {"high", "critical"} for f in valid),
            "confidence": sum((Decimal(str(f["confidence"])) for f in valid), Decimal(0)),
            "validated_cases": sorted(f["case_key"] for f in valid),
            "false_positives": sum(f["verdict"] == "false_positive" for f in review["findings"]),
            "known_misses": sorted(f["case_key"] for f in review["known_misses"]),
        }

    old, new = metrics(before), metrics(after)
    old_score = Decimal(str(old[config["metric"]]))
    new_score = Decimal(str(new[config["metric"]]))
    decimal_delta = new_score - old_score
    delta = float(decimal_delta) if config["metric"] == "confidence" else int(decimal_delta)
    reasons = []
    if before["target_fingerprint"] != after["target_fingerprint"]:
        reasons.append("Target source fingerprint differs; results are not comparable")
    if set(old["validated_cases"]) - set(new["validated_cases"]):
        reasons.append("Previously validated cases were lost")
    if new["false_positives"] > old["false_positives"]:
        reasons.append("False positives increased")
    if decimal_delta < Decimal(str(config["min_improvement"])):
        reasons.append("Metric improvement is below the configured threshold")
    old["confidence"] = float(old["confidence"])
    new["confidence"] = float(new["confidence"])
    return {
        "better": not reasons,
        "metric": config["metric"],
        "delta": delta,
        "baseline": old,
        "candidate": new,
        "reasons": reasons,
    }


def prompt_for(workflow, evidence, previous):
    template = Path(__file__).with_name("analyze_improve.txt").read_text()
    contracts = handoff_contracts(workflow)
    try:
        validate_handoffs(workflow)
        handoff_errors = []
    except HandoffValidationError as error:
        handoff_errors = [{"field": item["field"], "message": item["message"][:320]} for item in error.errors]
    history = []
    for attempt in previous[-3:]:
        failure = json.dumps(attempt.get("failure"), ensure_ascii=True)
        evaluation = attempt.get("evaluation") or {}
        history.append(
            {
                "iteration": attempt["iteration"],
                "evaluation": {key: evaluation.get(key) for key in ("better", "metric", "delta")},
                "failure_excerpt": failure[:500],
                "failure_truncated": len(failure) > 500,
            }
        )
    replacements = {}
    outline = copy.deepcopy(workflow)
    previews = []
    for level in outline["levels"]:
        for step in level["steps"]:
            content = step["content"]
            marker = "SIL_KEEP_" + hashlib.sha256(content.encode()).hexdigest()
            replacements[marker] = content
            step["content"] = marker
            previews.append({"marker": marker, "name": step["name"], "content": content})
    for size, evidence_limit in ((1200, 5000), (600, 3500), (200, 2000), (0, 1000)):
        excerpted = []
        for entry in previews:
            content = entry["content"]
            excerpt = (
                content
                if len(content) <= size
                else (content[: size // 3] + " [omitted] " + content[-(size - size // 3) :])
                if size
                else "[omitted]"
            )
            excerpted.append({**entry, "content": excerpt, "truncated": len(content) > size})
        # Evidence is bounded separately; its truncation is explicit, never silently dropped.
        serialized = json.dumps(evidence, ensure_ascii=True)
        evidence_text = serialized[:evidence_limit]
        data = {
            "workflow": outline,
            "handoff_requirements": contracts,
            "baseline_handoff_errors": handoff_errors,
            "prompt_previews": excerpted,
            "scan_evidence_text": evidence_text,
            "evidence_truncated": len(serialized) > evidence_limit,
            "previous_attempts": history,
        }
        request = template + "\nUNTRUSTED_INPUT_JSON:\n" + json.dumps(data, ensure_ascii=True)
        if len(request.encode("utf-16-le")) // 2 <= 19_800:
            return request, replacements
    raise ImprovementError("Workflow structure exceeds the generation context limit; reduce the selected workflow")


def expand_proposal(value, replacements, available_extra):
    expanded = copy.deepcopy(value)
    require(isinstance(expanded, dict), "Generated workflow must be an object")
    for level in expanded.get("levels", []):
        for step in level.get("steps", []):
            content = step.get("content", "")
            require(isinstance(content, str), "Invalid generated prompt")
            for marker in re.findall(r"SIL_KEEP_[a-f0-9]+", content):
                require(marker in replacements, "Unknown preserved-prompt marker")
                content = content.replace(marker, replacements[marker])
            require("SIL_KEEP_" not in content, "Unresolved preserved-prompt marker")
            step["content"] = content
    return validate_proposal(expanded, available_extra)
