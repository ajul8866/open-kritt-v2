"""Failure classification for model-harness errors.

`_classify_harness_output` decides two things per failure: the message an
operator sees, and whether the task is retried automatically or parked. A wrong
answer in the retryable direction wastes retries; a wrong answer in the
non-retryable direction parks work that a retry would have fixed.

The cases below use provider error text taken from vendor documentation:
Anthropic (platform.claude.com/docs/en/api/errors), OpenAI quota messages,
OpenRouter error bodies, and xAI capacity messages.
"""

import pytest

from open_kritt_engine.harnesses import _classify_harness_output


def classify(output: str, provider: str = "claude") -> str:
    return _classify_harness_output(output, provider=provider)


# --------------------------------------------------------------------------
# Provider overload / server-side failure -> provider_unavailable
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "provider"),
    [
        (
            'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            "claude",
        ),
        (
            'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
            "claude",
        ),
        ("We're currently experiencing high demand for gpt-5. Please try again later.", "codex"),
        ("The server had an error while processing your request. Sorry about that!", "codex"),
        ("stream error: unexpected status 503 Service Unavailable", "codex"),
        ('{"code":"The engine is currently overloaded, please try again later","error":"Service Unavailable"}', "xai"),
        (
            '{"error":{"message":"Provider returned error: DeepSeek is temporarily unavailable","code":503}}',
            "openrouter",
        ),
    ],
)
def test_provider_overload_classifies_as_provider_unavailable(output, provider):
    assert classify(output, provider) == "provider_unavailable"


# --------------------------------------------------------------------------
# Credentials -> auth_failed
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "provider"),
    [
        ("OAuth token has expired. Please run /login to re-authenticate.", "claude"),
        ('API Error: 401 {"error":{"message":"No auth credentials found"}}', "openrouter"),
        ("Your API key is not valid. Generate a new one in the console.", "claude"),
    ],
)
def test_expired_or_missing_credentials_classify_as_auth_failed(output, provider):
    assert classify(output, provider) == "auth_failed"


def test_bare_status_code_is_read_without_a_status_keyword():
    """`API Error: 500` carries no `status` token; the code alone must be read."""
    assert classify("API Error: 500 upstream failure", "claude") == "provider_unavailable"
    assert classify("API Error: 502 bad gateway", "codex") == "provider_unavailable"


# --------------------------------------------------------------------------
# Quota vs rate limit: the distinction that decides retryability
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "provider"),
    [
        (
            "Error code: 429 - {'error': {'message': 'You exceeded your current quota, "
            "please check your plan and billing details.', 'type': 'insufficient_quota'}}",
            "codex",
        ),
        ("Your account has run out of credits for this model.", "codex"),
    ],
)
def test_exhausted_billing_classifies_as_quota_not_rate_limit(output, provider):
    """Spent credits are durable: retrying cannot fix them.

    OpenRouter is excluded on purpose. Its credit failures are classified as
    retryable by an existing, separately tested decision
    (`test_openrouter_credit_limits_are_classified_as_rate_limited`), which
    `docs-site/ai-provider-setup/openrouter.mdx` describes as a 402 "insufficient
    credits" condition. Reconciling those two is a maintainer policy call.
    """
    assert classify(output, provider) == "quota_exceeded"


def test_openrouter_credit_failures_keep_their_existing_classification():
    """Pin the behaviour this change deliberately did not alter.

    The 402 body is OpenRouter's documented insufficient-credits response, yet
    the engine keeps retrying it. That is pre-existing behaviour this change
    leaves untouched.
    """
    assert classify('{"error":"requires more credits"}', "openrouter") == "rate_limited"
    assert classify('{"error":{"code":"insufficient_quota"}}', "openrouter") == "rate_limited"
    assert (
        classify(
            '{"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}',
            "openrouter",
        )
        == "rate_limited"
    )


def test_rate_limit_wording_still_wins_over_incidental_credit_mention():
    """OpenRouter's free-tier 429 mentions credits but is a daily rate limit."""
    output = (
        '{"error":{"message":"Rate limit exceeded: free-models-per-day. '
        'Add 10 credits to unlock 1000 free model requests per day","code":429}}'
    )
    assert classify(output, "openrouter") == "rate_limited"


# --------------------------------------------------------------------------
# Model availability -> model_unavailable
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "provider"),
    [
        ('{"error":{"message":"No endpoints found that support tool use.","code":404}}', "openrouter"),
        ("This model has been retired and is no longer available.", "openrouter"),
    ],
)
def test_missing_model_classifies_as_model_unavailable(output, provider):
    assert classify(output, provider) == "model_unavailable"


# --------------------------------------------------------------------------
# Regression: behaviour that is already correct must not change
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("output", "provider", "expected"),
    [
        ("API Error: 400 flagged for possible cybersecurity risk", "claude", "cyber_safety_blocked"),
        (
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
            '"message":"Your credit balance is too low to access the Claude API."}}',
            "claude",
            "quota_exceeded",
        ),
        (
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
            '"message":"prompt is too long: 215000 tokens > 200000 maximum"}}',
            "claude",
            "invalid_request",
        ),
        (
            "Error code: 400 - {'error': {'message': 'This model maximum context length is "
            "128000 tokens.', 'type': 'invalid_request_error', 'code': 'context_length_exceeded'}}",
            "codex",
            "invalid_request",
        ),
        ("You've hit your usage limit. Try again in 5 hours.", "codex", "account_quota_limited"),
        ("The selected model is at capacity. Please try a different model.", "claude", "model_capacity"),
        ("stream error: stream disconnected before completion: Connection reset by peer", "xai", "network_error"),
        ("Too many requests. Please slow down.", "codex", "rate_limited"),
        (
            '{"error":{"message":"The request was rejected because it was considered high risk","code":403}}',
            "openrouter",
            "provider_rejected",
        ),
        (
            '{"error":{"message":"Your team is not authorized to use model grok-4-fast","code":403}}',
            "xai",
            "model_access_denied",
        ),
        ("selected model is at capacity, try a different model", "claude", "model_capacity"),
    ],
)
def test_existing_classifications_are_preserved(output, provider, expected):
    assert classify(output, provider) == expected


def test_unknown_prose_falls_back_without_raising():
    assert classify("something inexplicable happened in the runner", "claude") == "harness_failed"
    assert classify("", "claude") == "harness_failed"


def test_repository_prose_about_overloading_is_not_a_provider_failure():
    """`overloaded` is ordinary programming vocabulary.

    This function scans harness output, which carries the agent's own prose about
    the repository under test. A file discussing operator overloading must not be
    read as a provider capacity failure.
    """
    assert classify("Refactored the operator overloading in lib/vector.hpp", "claude") == "harness_failed"
    assert classify("Added a function overload for the parser entry point", "codex") == "harness_failed"


# --------------------------------------------------------------------------
# The deterministic classifier must not require any model or network access
# --------------------------------------------------------------------------


def test_deterministic_classification_needs_no_model_credentials(monkeypatch):
    """Classification of provider errors is offline and pure.

    Every case in this module classifies from text alone; no TypeSafe key, no
    network, no model call.
    """
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    assert (
        classify('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', "claude")
        == "provider_unavailable"
    )
    assert classify("OAuth token has expired.", "claude") == "auth_failed"
