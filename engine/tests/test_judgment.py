"""Semantic judgment must stay optional, offline by default, and never fail the caller."""

from __future__ import annotations

import json
from typing import Any

import pytest

from open_kritt_engine import judgment


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("TYPESAFE_MODEL", raising=False)


def test_unavailable_without_a_key(monkeypatch):
    assert judgment.available() is False
    assert judgment.choice(state="x", instructions="y", criteria={"a": "b"}) is None


def test_available_with_a_key(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    assert judgment.available() is True


def test_blank_key_is_not_configured(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "   ")
    assert judgment.available() is False


def test_default_model_is_overridable(monkeypatch):
    assert judgment.model_name() == judgment.DEFAULT_MODEL
    monkeypatch.setenv("TYPESAFE_MODEL", "jev-1.13")
    assert judgment.model_name() == "jev-1.13"


def _stub_post(monkeypatch, response: Any):
    captured: dict[str, Any] = {}

    def fake_post(payload):
        captured["payload"] = payload
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    monkeypatch.setattr(judgment, "_post", fake_post)
    return captured


def test_returns_a_judgment_with_confidence(monkeypatch):
    _stub_post(
        monkeypatch,
        {"answers": {"answer": {"choice": "critical", "confidence": 0.97, "probabilities": {"critical": 0.97}}}},
    )
    result = judgment.choice(state={"a": 1}, instructions="how bad", criteria={"critical": "worst", "low": "least"})
    assert result is not None
    assert result.choice == "critical"
    assert result.confidence == pytest.approx(0.97)
    assert result.trusted is True


def test_sends_the_question_as_a_choice_with_the_catalog(monkeypatch):
    captured = _stub_post(
        monkeypatch, {"answers": {"answer": {"choice": "a", "confidence": 1.0, "probabilities": {"a": 1.0}}}}
    )
    judgment.choice(state={"text": "hi"}, instructions="pick one", criteria={"a": "first", "b": "second"})
    payload = captured["payload"]
    assert payload["model"] == judgment.DEFAULT_MODEL
    assert payload["state"] == {"text": "hi"}
    question = payload["questions"]["answer"]
    assert question["type"] == "choice"
    assert question["instructions"] == "pick one"
    assert question["criteria"] == {"a": "first", "b": "second"}


def test_low_confidence_is_not_trusted(monkeypatch):
    _stub_post(monkeypatch, {"answers": {"answer": {"choice": "a", "confidence": 0.51, "probabilities": {"a": 0.51}}}})
    result = judgment.choice(state="x", instructions="y", criteria={"a": "b", "c": "d"})
    assert result is not None
    assert result.trusted is False


def test_rejects_an_option_outside_the_catalog(monkeypatch):
    _stub_post(monkeypatch, {"answers": {"answer": {"choice": "invented", "confidence": 1.0, "probabilities": {}}}})
    assert judgment.choice(state="x", instructions="y", criteria={"a": "b"}) is None


def test_network_failure_returns_none_instead_of_raising(monkeypatch):
    import urllib.error

    _stub_post(monkeypatch, urllib.error.URLError("no route to host"))
    assert judgment.choice(state="x", instructions="y", criteria={"a": "b"}) is None


def test_malformed_response_returns_none_instead_of_raising(monkeypatch):
    _stub_post(monkeypatch, {"unexpected": True})
    assert judgment.choice(state="x", instructions="y", criteria={"a": "b"}) is None


def test_missing_confidence_is_treated_as_untrusted(monkeypatch):
    _stub_post(monkeypatch, {"answers": {"answer": {"choice": "a", "probabilities": {}}}})
    result = judgment.choice(state="x", instructions="y", criteria={"a": "b"})
    assert result is not None
    assert result.trusted is False


def test_module_uses_only_the_standard_library():
    """The engine ships three dependencies; semantic judgment must not add a fourth."""

    source = open(judgment.__file__, encoding="utf-8").read()
    assert "import requests" not in source
    assert "import httpx" not in source
    assert "from typesafe_sdk" not in source
    assert json is not None
