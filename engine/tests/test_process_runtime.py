import json
import subprocess
import sys
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses, workspace_snapshots
from open_kritt_engine.worker import Worker

DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {"message": {"type": "string"}, "count": {"type": "integer"}},
    "required": ["message", "count"],
    "additionalProperties": False,
}
DOCUMENT = {"message": "example", "count": 0}


# --------------------------------------------------------------------------
# Candidate selection: a quoted schema example must never become the result
# --------------------------------------------------------------------------

PLACEHOLDER_DOCUMENT = {"message": "<your finding here>", "count": 0}

# A realistic payload. DOCUMENT above uses the literal word "example", which is also a
# placeholder marker, so it cannot distinguish a real answer from a quoted template.
REAL_DOCUMENT = {"message": "Image optimizer fetches attacker-controlled URLs server-side", "count": 3}


def test_parser_prefers_the_real_answer_over_a_quoted_example_that_follows_it():
    """An agent that writes its answer first and quotes the format last.

    The schema-valid quoted example satisfies the schema, so returning it makes the
    step look successful while the real result is discarded.
    """

    text = (
        "Analysis complete. Result:\n"
        + json.dumps(REAL_DOCUMENT)
        + "\n\nFormat used:\n"
        + json.dumps(PLACEHOLDER_DOCUMENT)
    )
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == REAL_DOCUMENT


def test_parser_prefers_the_real_answer_when_the_example_comes_first():
    text = "Format used:\n" + json.dumps(PLACEHOLDER_DOCUMENT) + "\n\nFinal result:\n" + json.dumps(REAL_DOCUMENT)
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == REAL_DOCUMENT


@pytest.mark.parametrize(
    "placeholder",
    ["<your finding here>", "REPLACE_ME", "TODO", "EXAMPLE", "{{summary}}", "your finding here", "<summary>"],
)
def test_parser_rejects_placeholder_values(placeholder):
    placeholder_doc = {"message": placeholder, "count": 0}
    text = "Result:\n" + json.dumps(REAL_DOCUMENT) + "\n\nFormat:\n" + json.dumps(placeholder_doc)
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == REAL_DOCUMENT


def test_parser_keeps_a_real_answer_that_merely_mentions_a_placeholder_word():
    real = {"message": "Report contains the literal text EXAMPLE in the PoC", "count": 2}
    assert harnesses._parse_json_text(json.dumps(real), DOCUMENT_SCHEMA) == real


def test_parser_falls_back_to_the_only_candidate_when_every_candidate_looks_like_a_placeholder():
    """Better a flagged placeholder than a hard failure: the caller decides."""

    text = "Format:\n" + json.dumps(PLACEHOLDER_DOCUMENT)
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == PLACEHOLDER_DOCUMENT


def test_parser_recovers_a_complete_document_after_unbalanced_text():
    text = "unfinished { example\n" + json.dumps(DOCUMENT)
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == DOCUMENT


# --------------------------------------------------------------------------
# The production schema wraps the payload in a results array
# --------------------------------------------------------------------------

FINDING_FORMAT = {
    "vulnerability_type": "string",
    "summary": "string",
    "explanation": "string",
    "file_path": "string",
    "line": "number",
    "trigger_flow": "array",
    "malicious_input_example": "string",
    "malicious_actor": "string",
    "exploitable": "boolean",
}


def _production_schema():
    from open_kritt_engine.schema import output_schema

    return output_schema(FINDING_FORMAT, multi_output=False)


def _wrapped(**overrides):
    payload = {
        "_kritt_extractor_helper": True,
        "stub": False,
        "stub_explanation": "",
        "results": [
            {
                "vulnerability_type": "SSRF",
                "summary": "Image optimizer fetches attacker-controlled URLs server-side",
                "explanation": "_next/image passes the url parameter into a server-side fetch().",
                "file_path": "packages/next/server/image-optimizer.ts",
                "line": 142,
                "trigger_flow": ["Request with a crafted url", "Suffix check passes on the @-authority"],
                "malicious_input_example": "GET /_next/image?url=https://cdn.allowed.com@169.254.169.254/",
                "malicious_actor": "Unauthenticated remote user",
                "exploitable": True,
            }
        ],
    }
    payload.update(overrides)
    return payload


def _quoted_template():
    return {
        "_kritt_extractor_helper": True,
        "stub": False,
        "stub_explanation": "",
        "results": [
            {
                "vulnerability_type": "<vulnerability type>",
                "summary": "<your finding here>",
                "explanation": "<explanation>",
                "file_path": "path/to/file",
                "line": 0,
                "trigger_flow": [],
                "malicious_input_example": "<payload>",
                "malicious_actor": "<actor>",
                "exploitable": False,
            }
        ],
    }


@pytest.mark.parametrize("template_first", [False, True])
def test_wrapped_result_survives_a_quoted_template_in_either_order(template_first):
    """The production schema nests fields inside results, so scoring must recurse.

    Regression: a top-level-only placeholder scan saw the results array as one opaque
    value and scored the real answer and the quoted template identically.
    """

    real = json.dumps(_wrapped())
    template = json.dumps(_quoted_template())
    text = f"{template}\n\n{real}" if template_first else f"{real}\n\n{template}"

    parsed = harnesses._parse_json_text(text, _production_schema())
    assert parsed["results"][0]["summary"] == "Image optimizer fetches attacker-controlled URLs server-side"


def test_a_legitimate_empty_string_does_not_outrank_a_real_answer():
    """stub_explanation is empty on a real answer; an exact-zero threshold would misfire."""

    text = json.dumps(_wrapped()) + "\n\n" + json.dumps(_quoted_template())
    parsed = harnesses._parse_json_text(text, _production_schema())
    assert parsed["results"][0]["vulnerability_type"] == "SSRF"


def test_parser_rejects_a_document_that_does_not_match_its_schema():
    with pytest.raises(harnesses.HarnessError):
        harnesses._parse_json_text('{"message":"example","count":"wrong"}', DOCUMENT_SCHEMA)


@pytest.mark.parametrize("key", ["structuredOutput", "structured_output"])
@pytest.mark.parametrize("nested", [False, True])
def test_structured_response_wrappers_remain_compatible(key, nested):
    wrapped = {key: DOCUMENT}
    if nested:
        wrapped = {"result": wrapped}
    assert harnesses._extract_json(wrapped, DOCUMENT_SCHEMA) == DOCUMENT


def test_current_jsonl_message_shape_and_non_object_records():
    event = {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(DOCUMENT)}}
    output = 'null\n[]\n42\n"text"\n' + json.dumps(event)
    result = harnesses._jsonl_result(output, DOCUMENT_SCHEMA)
    assert result.payload == DOCUMENT


def test_command_output_is_not_classified_as_a_provider_error():
    event = {"type": "item.completed", "item": {"type": "command_execution", "output": "invalid API key"}}
    assert harnesses._codex_error_diagnostic_text(json.dumps(event), "") == ""
    error = json.dumps({"type": "turn.failed", "error": {"message": "request rejected"}})
    assert harnesses._codex_error_diagnostic_text(error, "") == error


def test_openrouter_stream_uses_valid_structured_output(monkeypatch, tmp_path):
    calls = []
    output = json.dumps({"type": "result", "structured_output": DOCUMENT, "usage": {"input_tokens": 1}})

    def run(command, prompt, cwd, timeout, env=None):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(harnesses, "_run_process", run)
    result = harnesses.ClaudeHarness(5, "openrouter").run(
        prompt="Return the example document.",
        schema=DOCUMENT_SCHEMA,
        repo_dir=str(tmp_path),
        model="example/model",
        env={"OPENROUTER_API_KEY": "synthetic-key"},
        allow_tools=False,
    )
    assert result.payload == DOCUMENT
    assert json.loads(calls[0][calls[0].index("--json-schema") + 1]) == DOCUMENT_SCHEMA
    assert calls[0][calls[0].index("--tools") + 1] == ""


def test_stream_error_takes_precedence_over_an_earlier_document():
    output = "\n".join(
        [
            json.dumps({"type": "result", "structured_output": DOCUMENT}),
            json.dumps({"type": "error", "error": {"message": "service unavailable"}}),
        ]
    )
    with pytest.raises(harnesses.HarnessError):
        harnesses._extract_json_from_claude_stream(output, provider="openrouter", schema=DOCUMENT_SCHEMA)


def test_process_output_is_spooled_and_recovered(tmp_path):
    result = harnesses._run_process(
        [sys.executable, "-c", "import sys; print('x' * 100000); print('notice', file=sys.stderr)"],
        "",
        str(tmp_path),
        5,
        env={},
    )
    assert result.stdout == "x" * 100000 + "\n"
    assert result.stderr == "notice\n"


def test_timeout_preserves_spooled_output(monkeypatch, tmp_path):
    def run(command, **kwargs):
        kwargs["stdout"].write("partial output")
        kwargs["stderr"].write("partial diagnostic")
        raise subprocess.TimeoutExpired(command, 1)

    monkeypatch.setattr(harnesses.subprocess, "run", run)
    with pytest.raises(harnesses.HarnessError) as raised:
        harnesses._run_process([sys.executable], "", str(tmp_path), 1, env={})
    assert raised.value.code == "timeout"
    assert raised.value.output.stdout == "partial output"
    assert raised.value.output.stderr == "partial diagnostic"


def test_memory_pressure_interruption_is_disabled_by_default(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_MEMORY_PRESSURE_EVICTION_ENABLED", raising=False)
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    worker = SimpleNamespace(config=SimpleNamespace(data_dir=str(tmp_path)))
    assert Worker.runtime_memory_pressure_eviction_enabled(worker) is False


def test_disabled_interruption_does_not_inspect_or_stop_jobs():
    worker = SimpleNamespace(runtime_memory_pressure_eviction_enabled=lambda: False)
    assert Worker._evict_runner_under_memory_pressure(worker) is None


def test_abnormal_container_exit_is_reported_as_capacity_pressure(monkeypatch, tmp_path):
    monkeypatch.setattr(harnesses, "_docker_run_details", lambda _cmd: ("example", "example-net"))
    monkeypatch.setattr(harnesses, "_prepare_docker_sandbox", lambda _cmd: None)
    monkeypatch.setattr(harnesses, "_cleanup_docker_run_container", lambda _cmd: None)
    monkeypatch.setattr(
        harnesses.subprocess, "run", lambda command, **_kwargs: subprocess.CompletedProcess(command, 137, "", "")
    )
    with pytest.raises(harnesses.HarnessError) as raised:
        harnesses._run_process(["docker", "run"], "", str(tmp_path), 5, env={})
    assert raised.value.code == "runner_resource_limited"


def test_network_creation_retries_pool_exhaustion_only(monkeypatch):
    calls = []

    def control(command):
        calls.append(command)
        if len(calls) == 1:
            return subprocess.CompletedProcess(command, 1, "", "all predefined address pools have been fully subnetted")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(harnesses, "_docker_run_details", lambda _cmd: ("example", "open-kritt-sandbox-example"))
    monkeypatch.setattr(harnesses, "SCAN_SANDBOX_NETWORK_PREFIX", "open-kritt-sandbox-")
    monkeypatch.setattr(harnesses, "_docker_control_run", control)
    harnesses._prepare_docker_sandbox(["docker"])
    assert len(calls) == 2
    assert "--subnet" in calls[1]
    assert calls[1][-1] == "open-kritt-sandbox-example"


@pytest.mark.parametrize("entrypoint,command", [(["unexpected"], ["/bin/true"]), (None, ["unexpected"])])
def test_snapshot_cache_rejects_executable_defaults(monkeypatch, entrypoint, command):
    inspected = {
        "Config": {
            "Labels": {workspace_snapshots.SNAPSHOT_KEY_LABEL: "example"},
            "Entrypoint": entrypoint,
            "Cmd": command,
        }
    }
    monkeypatch.setattr(workspace_snapshots, "_inspect_snapshot_image", lambda _image: inspected)
    assert workspace_snapshots._image_snapshot_key("example:local") is None
