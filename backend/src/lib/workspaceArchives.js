// Evidence archives written by the engine before it deletes a job workspace.
// The engine stores them under <engine data>/workspace-archives/scan-<id>/.
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_ARCHIVE_DIR_NAME = 'workspace-archives';
export const DEFAULT_ENGINE_DATA_DIR = '/engine-data';
export const DEFAULT_ARCHIVE_FILE = 'workspace.tar.gz';
export const MAX_ARCHIVE_ENTRIES = 500;
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export const ARCHIVE_ENTRY_PATTERN = /^metadata-\d+-\d{8}T\d{6}Z(?:-\d+)?$/;
const ARCHIVE_ENTRY_TIMESTAMP_PATTERN = /^metadata-\d+-(\d{8}T\d{6}Z)/;
const LEGACY_SESSION_PREFIXES = ['.codex/sessions/', '.claude/projects/', '.grok/sessions/'];
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENT_BYTES = 255;
const MAX_RELATIVE_PATH_BYTES = 4096;
const ROOT_FILES = new Map([
  ['workspace.tar.gz', 'application/gzip'],
  ['manifest.json', 'application/json; charset=utf-8'],
  ['README.txt', 'text/plain; charset=utf-8'],
]);

export class ArchiveError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ArchiveError';
    this.statusCode = statusCode;
  }
}

export class ArchiveNotFoundError extends ArchiveError {
  constructor(message = 'Archive not found.') {
    super(message, 404);
    this.name = 'ArchiveNotFoundError';
  }
}

export class ArchivePathError extends ArchiveError {
  constructor(message = 'That archive path is not allowed.') {
    super(message, 400);
    this.name = 'ArchivePathError';
  }
}

export function engineDataDir(env = process.env) {
  return env.OPEN_KRITT_ENGINE_DATA_DIR || DEFAULT_ENGINE_DATA_DIR;
}

export function archiveRoot(env = process.env) {
  return path.join(engineDataDir(env), WORKSPACE_ARCHIVE_DIR_NAME);
}

export function scanArchiveDirectory(scanId, { env = process.env } = {}) {
  return path.join(archiveRoot(env), `scan-${numericId(scanId)}`);
}

function numericId(value) {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new ArchivePathError('Invalid scan identifier.');
  return text;
}

function isInside(base, target) {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function integerOrNull(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function archiveEntryTimestamp(name) {
  return ARCHIVE_ENTRY_TIMESTAMP_PATTERN.exec(name)?.[1] || '';
}

// Older engine builds recorded transcript paths relative to HOME without the
// sessions/ prefix. Accept and normalize those only for known harness roots,
// then re-validate the prefixed path with the same rules as the download route.
function normalizeSessionFile(value) {
  if (typeof value !== 'string') return null;
  try {
    const normalized = normalizeArchiveRelativePath(value);
    return normalized.startsWith('sessions/') ? normalized : null;
  } catch {
    if (
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.endsWith('.jsonl') &&
      LEGACY_SESSION_PREFIXES.some((prefix) => value.startsWith(prefix))
    ) {
      try {
        return normalizeArchiveRelativePath(`sessions/${value}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function normalizeArchiveRelativePath(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_ARCHIVE_FILE;
  if (typeof value !== 'string') throw new ArchivePathError();
  const raw = value.trim();
  if (!raw || raw.includes('\0') || raw.includes('\\')) throw new ArchivePathError();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RELATIVE_PATH_BYTES) throw new ArchivePathError();
  if (ROOT_FILES.has(raw)) return raw;
  if (!raw.startsWith('sessions/')) throw new ArchivePathError();

  const segments = raw.split('/');
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !SAFE_SEGMENT_PATTERN.test(segment) ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES
    )
  ) {
    throw new ArchivePathError();
  }
  if (!segments[segments.length - 1].endsWith('.jsonl')) throw new ArchivePathError();
  return segments.join('/');
}

export function archiveContentType(relativePath) {
  const rootType = ROOT_FILES.get(relativePath);
  if (rootType) return rootType;
  if (relativePath.startsWith('sessions/')) return 'application/x-ndjson; charset=utf-8';
  return 'application/octet-stream';
}

export async function listScanArchives(
  scanId,
  { env = process.env, fsApi = fs, maxEntries = MAX_ARCHIVE_ENTRIES } = {}
) {
  const directory = scanArchiveDirectory(scanId, { env });
  let entries;
  try {
    entries = await fsApi.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  // Directory iteration order is filesystem-dependent. Pick the newest
  // entries by their embedded UTC timestamp before reading manifests so a
  // busy scan never gets an arbitrary subset.
  const candidates = entries
    .filter((entry) => entry.isDirectory() && ARCHIVE_ENTRY_PATTERN.test(entry.name))
    .map((entry) => ({ name: entry.name, timestamp: archiveEntryTimestamp(entry.name) }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.name.localeCompare(left.name))
    .slice(0, Math.max(0, maxEntries));

  const archives = [];
  for (const entry of candidates) {
    let manifest = null;
    let incomplete = false;
    try {
      const manifestPath = path.join(directory, entry.name, 'manifest.json');
      const stat = await fsApi.stat(manifestPath);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
        incomplete = true;
      } else {
        manifest = JSON.parse(await fsApi.readFile(manifestPath, 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
          manifest = null;
          incomplete = true;
        }
      }
    } catch {
      incomplete = true;
    }
    archives.push(summarizeArchiveEntry(entry.name, manifest, incomplete));
  }

  archives.sort((left, right) => {
    const byTime = String(right.archivedAt || '').localeCompare(String(left.archivedAt || ''));
    return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
  });
  return archives;
}

export function summarizeArchiveEntry(id, manifest, incomplete) {
  const archive = manifest?.archive && typeof manifest.archive === 'object' ? manifest.archive : {};
  const sessionFiles = Array.isArray(manifest?.session_files)
    ? manifest.session_files.map(normalizeSessionFile).filter(Boolean)
    : [];

  return {
    id,
    incomplete: Boolean(incomplete),
    kind: textOrNull(manifest?.kind),
    status: textOrNull(manifest?.status),
    workspaceMode: textOrNull(manifest?.workspace_mode),
    scanId: integerOrNull(manifest?.scan_id),
    workflowId: integerOrNull(manifest?.workflow_id),
    metadataId: integerOrNull(manifest?.metadata_id),
    stepId: integerOrNull(manifest?.step_id),
    vulnerabilityId: integerOrNull(manifest?.vulnerability_id),
    postScriptId: integerOrNull(manifest?.post_script_id),
    postScriptName: textOrNull(manifest?.post_script_name),
    archivedAt: textOrNull(manifest?.archived_at),
    expiresAt: textOrNull(manifest?.expires_at),
    retentionHours: typeof manifest?.retention_hours === 'number' ? manifest.retention_hours : null,
    bytes: integerOrNull(archive.bytes),
    files: integerOrNull(archive.files),
    sessionFiles,
  };
}

export async function listVulnerabilityArchives(scanId, vulnerabilityId, { env = process.env, fsApi = fs } = {}) {
  const target = integerOrNull(vulnerabilityId);
  if (target === null) throw new ArchivePathError('Invalid vulnerability identifier.');
  const archives = await listScanArchives(scanId, { env, fsApi });
  return archives.filter((entry) => entry.vulnerabilityId === target);
}

export async function resolveArchiveFile(
  scanId,
  entryId,
  relativePath = DEFAULT_ARCHIVE_FILE,
  { env = process.env, fsApi = fs } = {}
) {
  const entryName = String(entryId ?? '');
  if (!ARCHIVE_ENTRY_PATTERN.test(entryName)) throw new ArchiveNotFoundError();

  const safeRelativePath = normalizeArchiveRelativePath(relativePath);
  const rootDirectory = path.resolve(archiveRoot(env));
  const scanDirectory = path.resolve(scanArchiveDirectory(scanId, { env }));
  const entryDirectory = path.resolve(scanDirectory, entryName);
  if (!isInside(rootDirectory, scanDirectory) || !isInside(scanDirectory, entryDirectory)) {
    throw new ArchivePathError();
  }

  let scanStat;
  let entryStat;
  try {
    scanStat = await fsApi.lstat(scanDirectory);
    entryStat = await fsApi.lstat(entryDirectory);
  } catch {
    throw new ArchiveNotFoundError();
  }
  if (scanStat.isSymbolicLink() || !scanStat.isDirectory()) throw new ArchiveNotFoundError();
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) throw new ArchiveNotFoundError();

  let realRootDirectory;
  let realScanDirectory;
  let realEntryDirectory;
  try {
    realRootDirectory = await fsApi.realpath(rootDirectory);
    realScanDirectory = await fsApi.realpath(scanDirectory);
    realEntryDirectory = await fsApi.realpath(entryDirectory);
  } catch {
    throw new ArchiveNotFoundError();
  }
  if (!isInside(realRootDirectory, realScanDirectory) || !isInside(realScanDirectory, realEntryDirectory)) {
    throw new ArchivePathError();
  }

  const candidate = path.resolve(realEntryDirectory, ...safeRelativePath.split('/'));
  if (!isInside(realEntryDirectory, candidate)) throw new ArchivePathError();

  let stat;
  try {
    stat = await fsApi.lstat(candidate);
  } catch {
    throw new ArchiveNotFoundError();
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ArchiveNotFoundError();

  let realCandidate;
  try {
    realCandidate = await fsApi.realpath(candidate);
  } catch {
    throw new ArchiveNotFoundError();
  }
  if (!isInside(realEntryDirectory, realCandidate)) throw new ArchivePathError();

  return {
    path: realCandidate,
    filename: path.basename(realCandidate),
    relativePath: safeRelativePath,
    contentType: archiveContentType(safeRelativePath),
  };
}
