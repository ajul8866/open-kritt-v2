"""Semantic classification of provider errors that no deterministic signal covers.

The deterministic classifier in harnesses.py reads structured signals first (error
codes, HTTP statuses, documented `error.type` values) and its keyword lists only ever
see prose that is left over. This module adds a second, optional pass for exactly that
leftover prose, so a provider that rewords its errors still maps to the right class
instead of falling through to `harness_failed`.

Three rules make this safe to leave enabled:

* Deterministic first. A caller only reaches here when the keyword pass found nothing.
* Confidence gated. A low-confidence answer keeps the deterministic result.
* Prose only, and only a bounded slice. Harness output carries the agent's prose about
  the repository under test, so nothing here should receive a whole transcript.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping

from . import judgment
from .harnesses import HARNESS_FAILURE_MESSAGES

LOGGER = logging.getLogger(__name__)

# Only classes an operator can act on differently. `harness_failed` is deliberately
# absent: it is the fallback this pass exists to improve on, so returning it would
# spend a call to change nothing.
SEMANTIC_FAILURE_CLASSES: Mapping[str, str] = {
    "auth_failed": (
        "The provider rejected the credentials, or the sign-in session expired or was "
        "revoked. Not retryable: the account must be reconfigured."
    ),
    "quota_exceeded": (
        "The account's plan, credit balance, or hard spending limit is exhausted. Not "
        "retryable until the account is topped up or the limit is raised."
    ),
    "model_unavailable": (
        "The requested model does not exist, was retired or renamed, or is not offered "
        "by this provider. Not retryable with the same model name."
    ),
    "model_access_denied": (
        "The model exists but this account or key is not permitted to use it — a "
        "permission, entitlement, or region restriction. Not retryable as-is."
    ),
    "invalid_request": (
        "The request itself is malformed or unsupported: too long a context, an "
        "unexpected parameter, or a rejected value. Not retryable unchanged."
    ),
    "cyber_safety_blocked": (
        "The provider refused the request under a cybersecurity or safety policy, "
        "including being flagged for possible cyber risk. Not retryable on this account."
    ),
    "provider_unavailable": (
        "A transient provider-side failure: the service is overloaded, at capacity, or "
        "returning server errors. Retryable after a wait."
    ),
    "rate_limited": (
        "A transient request-rate limit — too many requests or tokens per interval. Retryable after a wait."
    ),
    "model_capacity": (
        "The specific model is temporarily at capacity while the provider itself is "
        "healthy. Retryable, or use another model meanwhile."
    ),
    "network_error": (
        "The engine could not reach the provider: DNS, TLS, proxy, or connection reset. "
        "Retryable after checking connectivity."
    ),
    "configuration_error": (
        "The local harness configuration is invalid or unreadable — a bad config file, "
        "an unknown feature flag, or a misconfigured proxy. Not retryable as-is."
    ),
    "invalid_output_schema": (
        "The provider rejected the JSON schema open-kritt sent for structured output. An "
        "engine compatibility problem, not a problem with the user's prompt."
    ),
    "provider_rejected": (
        "The provider rejected the request for a policy or account reason that is not "
        "one of the more specific classes above."
    ),
}

SEMANTIC_INSTRUCTIONS = (
    "A model provider returned the error text below while a security scan was running. "
    "Classify it into exactly one failure class.\n"
    "The text is raw provider output and may include an agent's prose about a code "
    "repository; that prose is not an error and must not be classified as one.\n"
    "Choose the class that decides what an operator should do next. If the text does "
    "not clearly describe a provider failure, choose the option that means the failure "
    "is unclassified."
)

UNCLASSIFIED = "unclassified"


def classify_failure_semantically(
    output: str,
    *,
    provider: str | None = None,
    max_chars: int = 4000,
) -> tuple[str, float] | None:
    """Classify leftover error prose. Returns (code, confidence), or None.

    None means "keep the deterministic answer": either judgment is not configured, the
    service failed, or the model was not confident enough to override it.
    """

    if not judgment.available():
        return None
    text = (output or "").strip()
    if not text:
        return None

    criteria = dict(SEMANTIC_FAILURE_CLASSES)
    criteria[UNCLASSIFIED] = (
        "The text does not describe a provider failure at all, or does not carry enough "
        "information to tell which class applies."
    )

    answer = judgment.choice(
        state={"provider": provider or "unknown", "error_text": text[:max_chars]},
        instructions=SEMANTIC_INSTRUCTIONS,
        criteria=criteria,
    )
    if answer is None:
        return None
    if not answer.trusted:
        LOGGER.info(
            "Semantic failure classification kept the deterministic result (confidence %.2f, choice %s)",
            answer.confidence,
            answer.choice,
        )
        return None
    if answer.choice == UNCLASSIFIED:
        return None
    if answer.choice not in HARNESS_FAILURE_MESSAGES:
        LOGGER.warning("Semantic failure classification returned an unknown code: %r", answer.choice)
        return None
    return answer.choice, answer.confidence
