"""Optional semantic judgment through TypeSafe, for cases deterministic code cannot decide.

Every call in this module is opt-in: without ``TYPESAFE_API_KEY`` the module reports
itself unavailable and callers must fall back to their deterministic path. That keeps
the engine dependency-free (standard library only) and keeps scans offline by default,
which is what SECURITY.md promises operators about data egress.

The design rule throughout: deterministic signals are read first by the caller, and
this module only ever sees prose that has no structured signal left in it.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

LOGGER = logging.getLogger(__name__)

TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
DEFAULT_MODEL = "jev-latest"

# Below this confidence the answer is treated as "the model is not sure", and the
# caller keeps its deterministic result instead of acting on a guess.
DEFAULT_CONFIDENCE_FLOOR = 0.85

REQUEST_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class Judgment:
    """One answered question, with the confidence needed to decide whether to trust it."""

    choice: str
    confidence: float
    probabilities: Mapping[str, float]

    @property
    def trusted(self) -> bool:
        return self.confidence >= DEFAULT_CONFIDENCE_FLOOR


def api_key() -> str:
    return (os.getenv("TYPESAFE_API_KEY") or "").strip()


def available() -> bool:
    """Whether semantic judgment is configured. Cheap: no network call."""

    return bool(api_key())


def model_name() -> str:
    return (os.getenv("TYPESAFE_MODEL") or "").strip() or DEFAULT_MODEL


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    key = api_key()
    if not key:
        raise RuntimeError("TYPESAFE_API_KEY is not configured")
    request = urllib.request.Request(
        TYPESAFE_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.load(response)


def choice(
    *,
    state: Any,
    instructions: str,
    criteria: Mapping[str, str],
    question_id: str = "answer",
) -> Judgment | None:
    """Ask one Choice question. Returns None on any failure or unusable answer.

    A failure here must never fail the caller's work: the caller has a deterministic
    path, and an optional judgment service being down is not a scan failure.
    """

    if not available():
        return None
    try:
        response = _post(
            {
                "model": model_name(),
                "state": state,
                "questions": {
                    question_id: {
                        "type": "choice",
                        "instructions": instructions,
                        "criteria": dict(criteria),
                    }
                },
            }
        )
        answer = response["answers"][question_id]
        chosen = answer["choice"]
        if chosen not in criteria:
            LOGGER.warning("Semantic judgment returned an option outside the catalog: %r", chosen)
            return None
        return Judgment(
            choice=str(chosen),
            confidence=float(answer.get("confidence") or 0.0),
            probabilities={str(k): float(v) for k, v in (answer.get("probabilities") or {}).items()},
        )
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        LOGGER.warning("Semantic judgment unavailable: %s", exc)
        return None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        LOGGER.warning("Semantic judgment returned an unusable response: %s", exc)
        return None
