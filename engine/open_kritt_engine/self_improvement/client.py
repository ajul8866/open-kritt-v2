import json
from http.client import IncompleteRead
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .contracts import ImprovementError, require


class SubmissionUnknown(ImprovementError):
    """A non-idempotent POST may have succeeded; never automatically retry it."""


class TransientReadError(ImprovementError):
    """A failed GET can be retried without repeating a creation request."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class KrittClient:
    def __init__(self, base_url="http://127.0.0.1:3002/api", timeout=30):
        parsed = urlsplit(base_url)
        require(parsed.scheme in {"http", "https"} and parsed.hostname, "Invalid backend URL")
        require(
            not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            "Backend URL cannot contain credentials, query or fragment",
        )
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None):
        require(path.startswith("/") and not path.startswith("//"), "Invalid API path")
        method = "GET" if body is None else "POST"
        request = Request(
            self.base_url + path,
            data=None if body is None else json.dumps(body, allow_nan=False).encode(),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                data = response.read(16 * 1024 * 1024 + 1)
                require(len(data) <= 16 * 1024 * 1024, "API response exceeds 16 MiB")
                return json.loads(data)
        except HTTPError as error:
            if method == "POST" and error.code >= 500:
                raise SubmissionUnknown(f"POST {path} returned HTTP {error.code}; reconcile before retrying") from error
            if method == "GET" and error.code in {408, 429, 500, 502, 503, 504}:
                raise TransientReadError(f"GET {path} returned HTTP {error.code}") from error
            raise ImprovementError(f"{method} {path} returned HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError, IncompleteRead) as error:
            if method == "POST":
                raise SubmissionUnknown(f"POST {path} outcome is unknown; reconcile before retrying") from error
            raise TransientReadError(f"Cannot read {path}: {type(error).__name__}") from error
        except ValueError as error:
            if method == "POST":
                raise SubmissionUnknown(f"POST {path} outcome is unknown; reconcile before retrying") from error
            raise ImprovementError(f"Cannot read {path}: {type(error).__name__}") from error

    def get(self, path):
        return self.request(path)

    def post(self, path, body):
        return self.request(path, body)
