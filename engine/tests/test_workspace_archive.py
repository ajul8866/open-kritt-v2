import json
import os
import tarfile

from open_kritt_engine.artifact_cleanup import cleanup_workspace_archives
from open_kritt_engine.workspace import JobWorkspace
from open_kritt_engine.workspace_archive import (
    archive_job_directory,
    archive_workspace,
    workspace_archive_retention_hours,
)


def _build_job_workspace(tmp_path):
    data_dir = tmp_path / "data"
    root = data_dir / "jobs" / "metadata-42"
    repo = root / "workspace"
    home = root / "home"
    for path in (repo / "test", repo / "src", repo / "lib", repo / "out", repo / "node_modules"):
        path.mkdir(parents=True)
    (repo / "test" / "StaleOracleFallbackFeePoC.t.sol").write_text("contract PoC {}\n", encoding="utf-8")
    (repo / "foundry.toml").write_text("[profile.default]\n", encoding="utf-8")
    (repo / "src" / "DualTokenVault.sol").write_text("contract Vault {}\n", encoding="utf-8")
    (repo / "lib" / "dependency.sol").write_text("contract Dependency {}\n", encoding="utf-8")
    (repo / "out" / "DualTokenVault.json").write_text("{}\n", encoding="utf-8")
    (repo / "node_modules" / "package.js").write_text("x\n", encoding="utf-8")
    (repo / "poc-link").symlink_to("/etc/hostname")
    os.mkfifo(repo / "pipe")
    session = home / ".codex" / "sessions" / "2026" / "10" / "21" / "rollout.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text('{"type":"message"}\n', encoding="utf-8")
    (home / ".codex" / "auth.json").write_text('{"token":"secret"}\n', encoding="utf-8")
    (home / ".codex" / "config.toml").write_text("secret config\n", encoding="utf-8")
    workspace = JobWorkspace(root_dir=str(root), repo_base_dir=str(root / "repos"), env={"HOME": str(home)})
    return workspace, data_dir, root


def test_archive_workspace_captures_poc_and_transcript(tmp_path):
    workspace, data_dir, root = _build_job_workspace(tmp_path)

    archive = archive_workspace(
        workspace,
        data_dir=str(data_dir),
        metadata_id=42,
        kind="supplemental_post_script",
        scan_id=381,
        workflow_id=122,
        vulnerability_id=829,
        post_script_id=4,
        post_script_name="PoC Creator",
        workspace_mode="copy",
        retention_hours=5,
        now=1_700_000_000,
    )

    assert archive is not None
    assert archive == data_dir / "workspace-archives" / "scan-381" / "metadata-42-20231114T221320Z"
    manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["scan_id"] == 381
    assert manifest["workflow_id"] == 122
    assert manifest["metadata_id"] == 42
    assert manifest["vulnerability_id"] == 829
    assert manifest["post_script_id"] == 4
    assert manifest["post_script_name"] == "PoC Creator"
    assert manifest["retention_hours"] == 5
    assert manifest["expires_at"] == "2023-11-15T03:13:20Z"
    assert manifest["workspace_root"] == str(root)
    assert manifest["workspace_mode"] == "copy"
    assert manifest["session_files"] == ["sessions/.codex/sessions/2026/10/21/rollout.jsonl"]

    with tarfile.open(archive / "workspace.tar.gz") as tarball:
        names = set(tarball.getnames())
    assert "test/StaleOracleFallbackFeePoC.t.sol" in names
    assert "foundry.toml" in names
    assert "src/DualTokenVault.sol" in names
    assert not any(name.startswith(("lib/", "out/", "node_modules/")) for name in names)
    assert "poc-link" not in names
    assert "pipe" not in names
    assert set(manifest["skipped_special_files"]) == {"poc-link", "pipe"}

    session_files = list((archive / "sessions").rglob("*.jsonl"))
    assert [path.name for path in session_files] == ["rollout.jsonl"]
    assert not (archive / "sessions" / ".codex" / "auth.json").exists()
    assert not (archive / "sessions" / ".codex" / "config.toml").exists()
    assert (archive / "README.txt").read_text(encoding="utf-8").startswith("open-kritt job evidence archive")


def test_archive_workspace_is_disabled_when_retention_is_zero(tmp_path):
    workspace, data_dir, _root = _build_job_workspace(tmp_path)

    archive = archive_workspace(
        workspace,
        data_dir=str(data_dir),
        metadata_id=42,
        kind="step",
        retention_hours=0,
    )

    assert archive is None
    assert not (data_dir / "workspace-archives").exists()


def test_archive_workspace_skips_workspace_over_size_limit(tmp_path):
    workspace, data_dir, _root = _build_job_workspace(tmp_path)

    archive = archive_workspace(
        workspace,
        data_dir=str(data_dir),
        metadata_id=42,
        kind="step",
        retention_hours=5,
        max_archive_bytes=10,
        max_file_bytes=1000,
    )

    assert archive is None
    assert not list((data_dir / "workspace-archives").rglob("*.partial"))
    assert not list((data_dir / "workspace-archives").rglob("workspace.tar.gz"))


def test_archive_workspace_returns_none_for_missing_workspace(tmp_path):
    workspace = JobWorkspace(root_dir=str(tmp_path / "missing"), repo_base_dir=str(tmp_path), env={})

    archive = archive_workspace(
        workspace,
        data_dir=str(tmp_path / "data"),
        metadata_id=42,
        kind="step",
        retention_hours=5,
    )

    assert archive is None


def test_archive_job_directory_uses_offset_workspace_id(tmp_path):
    data_dir = tmp_path / "data"
    repo = data_dir / "jobs" / "metadata-1000000042" / "workspace"
    (repo / "test").mkdir(parents=True)
    (repo / "test" / "PoC.t.sol").write_text("contract PoC {}\n", encoding="utf-8")

    archive = archive_job_directory(
        data_dir=str(data_dir),
        metadata_id=42,
        workspace_metadata_id=1_000_000_042,
        kind="post_script",
        scan_id=381,
        retention_hours=5,
    )

    assert archive is not None
    manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["metadata_id"] == 42
    assert manifest["workspace_root"].endswith("metadata-1000000042")
    with tarfile.open(archive / "workspace.tar.gz") as tarball:
        assert "test/PoC.t.sol" in tarball.getnames()


def test_cleanup_workspace_archives_removes_only_expired_entries(tmp_path):
    data_dir = tmp_path / "data"
    archive_root = data_dir / "workspace-archives"
    expired = archive_root / "scan-1" / "metadata-1-old"
    active = archive_root / "scan-1" / "metadata-2-new"
    stale_partial = archive_root / "scan-2" / "metadata-3-old.partial"
    expired_only_scan = archive_root / "scan-3" / "metadata-4-old"
    for path in (expired, active, stale_partial, expired_only_scan):
        path.mkdir(parents=True)
    now = 1_700_000_000
    old = now - 6 * 3600
    recent = now - 60
    os.utime(expired, (old, old))
    os.utime(active, (recent, recent))
    os.utime(expired_only_scan, (old, old))
    os.utime(stale_partial, (now - 2 * 3600, now - 2 * 3600))

    removed = cleanup_workspace_archives(str(data_dir), retention_hours=5, now=now)

    assert removed == 3
    assert not expired.exists()
    assert active.exists()
    assert not stale_partial.exists()
    assert not expired_only_scan.exists()
    assert not (archive_root / "scan-3").exists()
    assert (archive_root / "scan-1").is_dir()
    assert not (archive_root / "scan-2").exists()


def test_cleanup_workspace_archives_is_noop_when_disabled(tmp_path):
    data_dir = tmp_path / "data"
    expired = data_dir / "workspace-archives" / "scan-1" / "metadata-1-old"
    expired.mkdir(parents=True)
    os.utime(expired, (100, 100))

    assert cleanup_workspace_archives(str(data_dir), retention_hours=0, now=1_700_000_000) == 0
    assert expired.exists()


def test_archive_retention_defaults_to_five_hours(monkeypatch):
    monkeypatch.delenv("ENGINE_WORKSPACE_ARCHIVE_RETENTION_HOURS", raising=False)
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)

    assert workspace_archive_retention_hours(None) == 5.0


def test_archive_workspace_skips_empty_or_relative_root(tmp_path):
    for root_dir in ("", "relative/path"):
        workspace = JobWorkspace(root_dir=root_dir, repo_base_dir=str(tmp_path), env={})

        archive = archive_workspace(
            workspace,
            data_dir=str(tmp_path / "data"),
            metadata_id=42,
            kind="step",
            retention_hours=5,
        )

        assert archive is None
    assert not (tmp_path / "data" / "workspace-archives").exists()


def test_archive_readme_describes_image_mode(tmp_path):
    workspace, data_dir, _root = _build_job_workspace(tmp_path)

    archive = archive_workspace(
        workspace,
        data_dir=str(data_dir),
        metadata_id=42,
        kind="step",
        workspace_mode="image",
        retention_hours=5,
    )

    assert archive is not None
    readme = (archive / "README.txt").read_text(encoding="utf-8")
    assert "wrapper workspace only" in readme
    assert "disposable runner image" in readme
    assert "including PoC files" not in readme


def test_archive_aborts_instead_of_publishing_a_corrupt_tarball(tmp_path, monkeypatch):
    workspace, data_dir, _root = _build_job_workspace(tmp_path)
    original_add = tarfile.TarFile.add

    def failing_add(self, name, arcname=None, recursive=True, **kwargs):
        if str(arcname).endswith("StaleOracleFallbackFeePoC.t.sol"):
            raise OSError("simulated read failure")
        return original_add(self, name, arcname=arcname, recursive=recursive, **kwargs)

    monkeypatch.setattr(tarfile.TarFile, "add", failing_add)

    archive = archive_workspace(
        workspace,
        data_dir=str(data_dir),
        metadata_id=42,
        kind="step",
        retention_hours=5,
    )

    assert archive is None
    assert not list((data_dir / "workspace-archives").rglob("workspace.tar.gz"))
    assert not list((data_dir / "workspace-archives").rglob("*.partial"))
