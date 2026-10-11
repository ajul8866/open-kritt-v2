import fcntl
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .contracts import ImprovementError, canonical, require


class Journal:
    """Private local state, with a process lock and append-only audit events."""

    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        self.db = sqlite3.connect(self.path, timeout=5)
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS loops (
                id TEXT PRIMARY KEY, api TEXT NOT NULL, root_scan_id TEXT NOT NULL,
                state_json TEXT NOT NULL, UNIQUE(api, root_scan_id)
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY, loop_id TEXT NOT NULL REFERENCES loops(id),
                created_at TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events
                BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events
                BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
        """)

    @contextmanager
    def locked(self):
        # One lock covers all loops in this journal, including POST acknowledgement gaps.
        with self.path.open("rb") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ImprovementError("Another controller is using this journal") from error
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def create(self, state):
        try:
            with self.db:
                self.db.execute(
                    "INSERT INTO loops VALUES (?, ?, ?, ?)",
                    (state["id"], state["api"], state["root_scan_id"], canonical(state)),
                )
                self._event(state["id"], "enabled", {"configuration": state["config"]})
        except sqlite3.IntegrityError as error:
            raise ImprovementError("This baseline scan already has a loop in this journal") from error

    def load(self, loop_id):
        row = self.db.execute("SELECT state_json FROM loops WHERE id = ?", (loop_id,)).fetchone()
        require(row is not None, "Loop not found")
        return json.loads(row[0])

    def save(self, state, kind, payload=None):
        with self.db:
            self.db.execute("UPDATE loops SET state_json = ? WHERE id = ?", (canonical(state), state["id"]))
            self._event(state["id"], kind, payload or {})

    def _event(self, loop_id, kind, payload):
        self.db.execute(
            "INSERT INTO events(loop_id, created_at, kind, payload_json) VALUES (?, ?, ?, ?)",
            (loop_id, datetime.now(UTC).isoformat(), kind, canonical(payload)),
        )

    def events(self, loop_id):
        return [
            {"id": row[0], "at": row[1], "kind": row[2], "payload": json.loads(row[3])}
            for row in self.db.execute(
                "SELECT id, created_at, kind, payload_json FROM events WHERE loop_id = ? ORDER BY id", (loop_id,)
            )
        ]

    def close(self):
        self.db.close()
