"""Durable evidence archives for disposable job workspaces.

Every engine job runs in a per-job copy of the repository and the engine deletes
that copy as soon as the harness exits. PoC files written by an agent and the
harness session transcript therefore disappear with the job. Before the
cleanup, this module snapshots the useful evidence into
``<data_dir>/workspace-archives``. The periodic artifact sweeper removes those
archives after ``ENGINE_WORKSPACE_ARCHIVE_RETENTION_HOURS``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .artifact_cleanup import WORKSPACE_ARCHIVE_DIR_NAME
from .runtime_config import runtime_float

LOGGER = logging.getLogger("open_kritt_engine.workspace_archive")

MANIFEST_FILE_NAME = "manifest.json"
README_FILE_NAME = "README.txt"
WORKSPACE_TARBALL_NAME = "workspace.tar.gz"
ARCHIVE_SCHEMA_VERSION = 1

_PARTIAL_SUFFIX = ".partial"
_DEFAULT_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
_DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
_DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024

# Dependencies and build output are restorable from the checkout cache and are
# the main source of multi-hundred-megabyte workspaces. Evidence files (tests,
# scripts, sources, configs) stay in the archive.
_EXCLUDED_DIR_NAMES = frozenset(
    {
        ".foundry",
        ".git",
        ".gradle",
        ".hg",
        ".mypy_cache",
        ".next",
        ".nuxt",
        ".pytest_cache",
        ".ruff_cache",
        ".svn",
        ".terraform",
        ".turbo",
        ".venv",
        "__pycache__",
        "broadcast",
        "build",
        "cache",
        "dist",
        "lib",
        "node_modules",
        "out",
        "target",
        "venv",
    }
)

# Harness transcript locations relative to the job HOME. Only .jsonl session
# files are copied; credential files such as .codex/auth.json never are.
_SESSION_DIRS = (".codex/sessions", ".claude/projects", ".grok/sessions")
_SESSION_SUFFIXES = (".jsonl",)


@dataclass(frozen=True)
class _TarStats:
    bytes: int
    files: int
    skipped: list[str]
    skipped_special: list[str]


class _ArchiveLimitExceeded(Exception):
    pass


class _ArchiveWriteError(Exception):
    pass


def workspace_archive_retention_hours(data_dir: str | None = None) -> float:
    """Return the configured archive retention in hours (0 disables archiving)."""

    return runtime_float(
        "ENGINE_WORKSPACE_ARCHIVE_RETENTION_HOURS",
        5.0,
        data_dir=data_dir,
        minimum=0.0,
        maximum=24.0 * 365.0,
    )


def archive_workspace(
    workspace: Any,
    *,
    data_dir: str,
    metadata_id: int,
    kind: str,
    scan_id: int | None = None,
    workflow_id: int | None = None,
    step_id: int | None = None,
    vulnerability_id: int | None = None,
    target_vulnerability_ids: list[int] | None = None,
    post_script_id: int | None = None,
    post_script_name: str | None = None,
    status: str | None = None,
    workspace_mode: str | None = None,
    repo_dir: str | Path | None = None,
    checked_out_commit: str | None = None,
    model: str | None = None,
    harness: str | None = None,
    archive_context: dict[str, Any] | None = None,
    retention_hours: float | None = None,
    now: float | None = None,
    max_archive_bytes: int = _DEFAULT_MAX_ARCHIVE_BYTES,
    max_file_bytes: int = _DEFAULT_MAX_FILE_BYTES,
    max_session_bytes: int = _DEFAULT_MAX_SESSION_BYTES,
) -> Path | None:
    """Archive one job workspace before it is removed.

    Returns the archive directory, or ``None`` when archiving is disabled or
    fails. Failures are logged and never block job cleanup.
    """

    hours = workspace_archive_retention_hours(data_dir) if retention_hours is None else float(retention_hours)
    if hours <= 0:
        return None

    root = Path(str(getattr(workspace, "root_dir", "") or ""))
    if not str(getattr(workspace, "root_dir", "") or "").strip() or not root.is_absolute():
        LOGGER.warning("workspace archive skipped for metadata %s: workspace root is missing", metadata_id)
        return None
    if not root.is_dir():
        LOGGER.warning("workspace archive skipped for metadata %s: %s does not exist", metadata_id, root)
        return None

    env = getattr(workspace, "env", None)
    home = Path(str(env.get("HOME"))) if isinstance(env, dict) and env.get("HOME") else root / "home"
    context = archive_context or {}
    return _write_archive(
        data_dir=data_dir,
        root=root,
        home=home,
        repo_dir=Path(repo_dir) if repo_dir is not None else root / "workspace",
        metadata_id=metadata_id,
        kind=kind,
        scan_id=scan_id,
        workflow_id=workflow_id,
        step_id=step_id,
        vulnerability_id=vulnerability_id,
        target_vulnerability_ids=target_vulnerability_ids,
        post_script_id=post_script_id,
        post_script_name=post_script_name,
        status=status,
        workspace_mode=workspace_mode,
        checked_out_commit=checked_out_commit,
        model=model,
        harness=harness,
        context=context,
        retention_hours=hours,
        now=now,
        max_archive_bytes=max_archive_bytes,
        max_file_bytes=max_file_bytes,
        max_session_bytes=max_session_bytes,
    )


def archive_job_directory(
    *,
    data_dir: str,
    metadata_id: int,
    kind: str,
    workspace_metadata_id: int | None = None,
    scan_id: int | None = None,
    workflow_id: int | None = None,
    step_id: int | None = None,
    vulnerability_id: int | None = None,
    target_vulnerability_ids: list[int] | None = None,
    post_script_id: int | None = None,
    post_script_name: str | None = None,
    status: str | None = None,
    checked_out_commit: str | None = None,
    model: str | None = None,
    harness: str | None = None,
    archive_context: dict[str, Any] | None = None,
    retention_hours: float | None = None,
    now: float | None = None,
) -> Path | None:
    """Archive a job directory when workspace preparation never completed."""

    hours = workspace_archive_retention_hours(data_dir) if retention_hours is None else float(retention_hours)
    if hours <= 0:
        return None
    job_id = workspace_metadata_id if workspace_metadata_id is not None else metadata_id
    root = Path(data_dir) / "jobs" / f"metadata-{job_id}"
    if not root.is_dir():
        return None
    return _write_archive(
        data_dir=data_dir,
        root=root,
        home=root / "home",
        repo_dir=root / "workspace",
        metadata_id=metadata_id,
        kind=kind,
        scan_id=scan_id,
        workflow_id=workflow_id,
        step_id=step_id,
        vulnerability_id=vulnerability_id,
        target_vulnerability_ids=target_vulnerability_ids,
        post_script_id=post_script_id,
        post_script_name=post_script_name,
        status=status,
        workspace_mode=None,
        checked_out_commit=checked_out_commit,
        model=model,
        harness=harness,
        context=archive_context or {},
        retention_hours=hours,
        now=now,
        max_archive_bytes=_DEFAULT_MAX_ARCHIVE_BYTES,
        max_file_bytes=_DEFAULT_MAX_FILE_BYTES,
        max_session_bytes=_DEFAULT_MAX_SESSION_BYTES,
    )


def _write_archive(
    *,
    data_dir: str,
    root: Path,
    home: Path,
    repo_dir: Path,
    metadata_id: int,
    kind: str,
    scan_id: int | None,
    workflow_id: int | None,
    step_id: int | None,
    vulnerability_id: int | None,
    target_vulnerability_ids: list[int] | None,
    post_script_id: int | None,
    post_script_name: str | None,
    status: str | None,
    workspace_mode: str | None,
    checked_out_commit: str | None,
    model: str | None,
    harness: str | None,
    context: dict[str, Any],
    retention_hours: float,
    now: float | None,
    max_archive_bytes: int,
    max_file_bytes: int,
    max_session_bytes: int,
) -> Path | None:
    archived_at = time.time() if now is None else float(now)
    scan_key = f"scan-{int(scan_id)}" if scan_id is not None else "scan-unknown"
    base = Path(data_dir) / WORKSPACE_ARCHIVE_DIR_NAME / scan_key
    stamp = datetime.fromtimestamp(archived_at, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    final_dir = base / f"metadata-{metadata_id}-{stamp}"
    if final_dir.exists():
        final_dir = base / f"metadata-{metadata_id}-{stamp}-{time.time_ns()}"
    partial_dir = final_dir.with_name(final_dir.name + _PARTIAL_SUFFIX)

    try:
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial_dir.mkdir(mode=0o700)
        tar_stats = _write_workspace_tarball(
            repo_dir,
            partial_dir / WORKSPACE_TARBALL_NAME,
            max_archive_bytes=max_archive_bytes,
            max_file_bytes=max_file_bytes,
        )
        session_files, session_bytes = _copy_session_transcripts(
            home,
            partial_dir / "sessions",
            max_session_bytes=max_session_bytes,
        )
        manifest = {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "archived_at": _iso_timestamp(archived_at),
            "retention_hours": retention_hours,
            "expires_at": _iso_timestamp(archived_at + retention_hours * 3600),
            "scan_id": scan_id,
            "workflow_id": workflow_id,
            "metadata_id": metadata_id,
            "kind": kind,
            "step_id": step_id,
            "vulnerability_id": vulnerability_id,
            "target_vulnerability_ids": target_vulnerability_ids,
            "post_script_id": post_script_id,
            "post_script_name": post_script_name,
            "status": status,
            "workspace_mode": workspace_mode,
            "checked_out_commit": checked_out_commit,
            "model": model,
            "harness": harness,
            "workspace_root": str(root),
            "repo_dir": str(repo_dir),
            "archive": {
                "name": WORKSPACE_TARBALL_NAME,
                "bytes": tar_stats.bytes,
                "files": tar_stats.files,
            },
            "excluded_dir_names": sorted(_EXCLUDED_DIR_NAMES),
            "skipped_large_files": tar_stats.skipped,
            "skipped_special_files": tar_stats.skipped_special,
            "session_files": session_files,
            "session_bytes": session_bytes,
            "context": _json_safe(context),
        }
        _write_json(partial_dir / MANIFEST_FILE_NAME, manifest)
        _write_text(partial_dir / README_FILE_NAME, _readme_text(manifest))
        os.replace(partial_dir, final_dir)
        LOGGER.info(
            "archived metadata %s scan %s (%s) to %s: %s files, %s bytes, %s session files",
            metadata_id,
            scan_id,
            kind,
            final_dir,
            tar_stats.files,
            tar_stats.bytes,
            len(session_files),
        )
        return final_dir
    except _ArchiveLimitExceeded as exc:
        shutil.rmtree(partial_dir, ignore_errors=True)
        LOGGER.warning("workspace archive skipped for metadata %s: %s", metadata_id, exc)
        return None
    except _ArchiveWriteError as exc:
        shutil.rmtree(partial_dir, ignore_errors=True)
        LOGGER.warning("workspace archive aborted for metadata %s: %s", metadata_id, exc)
        return None
    except Exception as exc:  # noqa: BLE001 - archival must never break cleanup
        shutil.rmtree(partial_dir, ignore_errors=True)
        LOGGER.warning("workspace archive failed for metadata %s: %s", metadata_id, exc, exc_info=True)
        return None


def _write_workspace_tarball(
    repo_dir: Path,
    target: Path,
    *,
    max_archive_bytes: int,
    max_file_bytes: int,
) -> _TarStats:
    if not repo_dir.is_dir():
        return _TarStats(bytes=0, files=0, skipped=[], skipped_special=[])

    total_bytes = 0
    file_count = 0
    skipped: list[str] = []
    skipped_special: list[str] = []
    with tarfile.open(target, "w:gz") as archive:
        for current, dirs, files in os.walk(repo_dir, followlinks=False):
            current_path = Path(current)
            dirs[:] = [
                name for name in dirs if name not in _EXCLUDED_DIR_NAMES and not (current_path / name).is_symlink()
            ]
            for name in files:
                path = current_path / name
                try:
                    stat_result = path.lstat()
                except OSError:
                    skipped_special.append(path.relative_to(repo_dir).as_posix())
                    continue
                arcname = path.relative_to(repo_dir).as_posix()
                if stat.S_ISLNK(stat_result.st_mode) or not stat.S_ISREG(stat_result.st_mode):
                    skipped_special.append(arcname)
                    continue
                if stat_result.st_size > max_file_bytes:
                    skipped.append(arcname)
                    continue
                total_bytes += stat_result.st_size
                if total_bytes > max_archive_bytes:
                    raise _ArchiveLimitExceeded(f"workspace evidence exceeds {max_archive_bytes} bytes at {arcname}")
                try:
                    archive.add(path, arcname=arcname, recursive=False)
                    file_count += 1
                except (OSError, tarfile.TarError) as exc:
                    raise _ArchiveWriteError(f"could not add {arcname}: {exc}") from exc
    return _TarStats(bytes=total_bytes, files=file_count, skipped=skipped, skipped_special=skipped_special)


def _copy_session_transcripts(home: Path, target_root: Path, *, max_session_bytes: int) -> tuple[list[str], int]:
    copied: list[str] = []
    total_bytes = 0
    if not home.is_dir():
        return copied, total_bytes

    for relative_dir in _SESSION_DIRS:
        session_root = home / relative_dir
        if not session_root.is_dir() or session_root.is_symlink():
            continue
        for current, _dirs, files in os.walk(session_root, followlinks=False):
            for name in files:
                if not name.endswith(_SESSION_SUFFIXES):
                    continue
                source = Path(current) / name
                if source.is_symlink() or not source.is_file():
                    continue
                try:
                    size = source.stat().st_size
                except OSError:
                    continue
                if total_bytes + size > max_session_bytes:
                    continue
                relative_path = source.relative_to(home)
                destination = target_root / relative_path
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.copy2(source, destination)
                except OSError:
                    continue
                copied.append(destination.relative_to(target_root.parent).as_posix())
                total_bytes += size
    return copied, total_bytes


def _readme_text(manifest: dict[str, Any]) -> str:
    if manifest.get("workspace_mode") == "image":
        workspace_note = (
            "workspace.tar.gz contains the wrapper workspace only. Agent-written\n"
            "files remain in the disposable runner image and are not included.\n"
            "Dependency and build directories are excluded:\n"
        )
    else:
        workspace_note = (
            "workspace.tar.gz contains the job repository copy, including PoC files\n"
            "written by the agent. Dependency and build directories are excluded:\n"
        )
    return (
        "open-kritt job evidence archive\n"
        "\n"
        f"Archived at: {manifest['archived_at']}\n"
        f"Retention:   {manifest['retention_hours']} hours (expires {manifest['expires_at']})\n"
        f"Scan:        {manifest['scan_id']}\n"
        f"Metadata:    {manifest['metadata_id']} ({manifest['kind']})\n"
        f"Vulnerability: {manifest['vulnerability_id']}\n"
        f"Post script: {manifest['post_script_name']}\n"
        "\n"
        f"{workspace_note}"
        f"{', '.join(manifest['excluded_dir_names'])}\n"
        "\n"
        "sessions/ contains harness transcript files (.jsonl). Credential files\n"
        "such as auth.json are not copied, but transcripts can contain secrets\n"
        "printed by the agent. Treat every archive as sensitive.\n"
    )


def _write_json(path: Path, payload: dict[str, Any]):
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _write_text(path: Path, content: str):
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


def _iso_timestamp(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return {key: str(item) for key, item in value.items()} if isinstance(value, dict) else str(value)
    return value
