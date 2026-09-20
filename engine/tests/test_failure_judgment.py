"""The semantic failure pass must never override a confident deterministic answer."""

from __future__ import annotations

import pytest

from open_kritt_engine import failure_judgment, judgment


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)


def test_returns_none_when_judgment_is_not_configured():
    assert failure_judgment.classify_failure_semantically("some provider prose") is None


def test_returns_none_for_empty_output(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    assert failure_judgment.classify_failure_semantically("   ") is None


def _stub(monkeypatch, choice, confidence):
    captured = {}

    def fake_choice(*, state, instructions, criteria, question_id="answer"):
        captured["state"] = state
        captured["criteria"] = criteria
        return judgment.Judgment(choice=choice, confidence=confidence, probabilities={choice: confidence})

    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    monkeypatch.setattr(judgment, "choice", fake_choice)
    return captured


def test_returns_the_classified_code_with_confidence(monkeypatch):
    _stub(monkeypatch, "model_unavailable", 0.95)
    assert failure_judgment.classify_failure_semantically("the model you requested no longer exists") == (
        "model_unavailable",
        0.95,
    )


def test_low_confidence_keeps_the_deterministic_result(monkeypatch):
    _stub(monkeypatch, "quota_exceeded", 0.62)
    assert failure_judgment.classify_failure_semantically("unclear billing prose") is None


def test_unclassified_answer_keeps_the_deterministic_result(monkeypatch):
    _stub(monkeypatch, failure_judgment.UNCLASSIFIED, 0.99)
    assert failure_judgment.classify_failure_semantically("repo prose that is not an error") is None


def test_a_code_without_an_operator_message_is_rejected(monkeypatch):
    _stub(monkeypatch, "not_a_real_code", 0.99)
    assert failure_judgment.classify_failure_semantically("prose") is None


def test_never_returns_the_fallback_class_it_exists_to_improve_on(monkeypatch):
    """Returning harness_failed would spend a call to change nothing."""

    assert "harness_failed" not in failure_judgment.SEMANTIC_FAILURE_CLASSES


def test_every_class_has_an_operator_message():
    from open_kritt_engine.harnesses import HARNESS_FAILURE_MESSAGES

    for code in failure_judgment.SEMANTIC_FAILURE_CLASSES:
        assert code in HARNESS_FAILURE_MESSAGES, f"{code} has no operator message"


def test_output_is_truncated_before_it_leaves_the_process(monkeypatch):
    captured = _stub(monkeypatch, "provider_unavailable", 0.95)
    failure_judgment.classify_failure_semantically("x" * 50_000, max_chars=1000)
    assert len(captured["state"]["error_text"]) == 1000


def test_provider_is_passed_as_context(monkeypatch):
    captured = _stub(monkeypatch, "provider_unavailable", 0.95)
    failure_judgment.classify_failure_semantically("overloaded", provider="claude")
    assert captured["state"]["provider"] == "claude"


def test_instructions_warn_that_repository_prose_is_not_an_error():
    assert "repository" in failure_judgment.SEMANTIC_INSTRUCTIONS
    assert "not an error" in failure_judgment.SEMANTIC_INSTRUCTIONS


def test_the_unclassified_escape_hatch_is_offered_to_the_model(monkeypatch):
    captured = _stub(monkeypatch, failure_judgment.UNCLASSIFIED, 0.99)
    failure_judgment.classify_failure_semantically("ambiguous text")
    assert failure_judgment.UNCLASSIFIED in captured["criteria"]
