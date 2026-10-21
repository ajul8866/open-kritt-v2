import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import {
  ArchiveNotFoundError,
  ArchivePathError,
  archiveRoot,
  listScanArchives,
  listVulnerabilityArchives,
  normalizeArchiveRelativePath,
  resolveArchiveFile,
  scanArchiveDirectory,
  summarizeArchiveEntry,
} from '../src/lib/workspaceArchives.js';

async function makeArchiveRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'kritt-archives-'));
  return root;
}

async function writeArchive(root, scanId, entryId, manifest, extraFiles = {}) {
  const directory = path.join(root, 'workspace-archives', `scan-${scanId}`, entryId);
  await mkdir(directory, { recursive: true });
  if (manifest !== undefined) {
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }
  for (const [name, content] of Object.entries(extraFiles)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return directory;
}

async function startServer(env) {
  const server = createApp({ env }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('normalizeArchiveRelativePath allows only evidence files and session transcripts', () => {
  assert.equal(normalizeArchiveRelativePath(undefined), 'workspace.tar.gz');
  assert.equal(normalizeArchiveRelativePath(''), 'workspace.tar.gz');
  assert.equal(normalizeArchiveRelativePath('workspace.tar.gz'), 'workspace.tar.gz');
  assert.equal(normalizeArchiveRelativePath('manifest.json'), 'manifest.json');
  assert.equal(normalizeArchiveRelativePath('README.txt'), 'README.txt');
  assert.equal(
    normalizeArchiveRelativePath('sessions/.codex/sessions/2026/10/21/rollout.jsonl'),
    'sessions/.codex/sessions/2026/10/21/rollout.jsonl'
  );

  for (const value of [
    '../manifest.json',
    'sessions/../../etc/passwd',
    'sessions/.codex/auth.json',
    'sessions/.codex/session.txt',
    '/etc/passwd',
    'workspace.tar.gz/../../x',
    'sessions//rollout.jsonl',
    'sessions\\.codex\\rollout.jsonl',
    'notes.txt',
    ['workspace.tar.gz'],
  ]) {
    assert.throws(() => normalizeArchiveRelativePath(value), ArchivePathError, String(value));
  }

  const segment255 = `${'a'.repeat(249)}.jsonl`;
  const segment254 = `${'a'.repeat(248)}.jsonl`;
  const segment256 = `${'a'.repeat(250)}.jsonl`;
  assert.equal(normalizeArchiveRelativePath(`sessions/${segment255}`), `sessions/${segment255}`);
  assert.throws(() => normalizeArchiveRelativePath(`sessions/${segment256}`), ArchivePathError);

  const path4096 = `sessions/${[...Array(8).fill(segment255), ...Array(8).fill(segment254)].join('/')}`;
  const path4097 = `sessions/${[...Array(9).fill(segment255), ...Array(7).fill(segment254)].join('/')}`;
  assert.equal(Buffer.byteLength(path4096, 'utf8'), 4096);
  assert.equal(Buffer.byteLength(path4097, 'utf8'), 4097);
  assert.equal(normalizeArchiveRelativePath(path4096), path4096);
  assert.throws(() => normalizeArchiveRelativePath(path4097), ArchivePathError);
});

test('listScanArchives returns sorted manifests and ignores partial or malformed entries', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  try {
    await writeArchive(
      env.OPEN_KRITT_ENGINE_DATA_DIR,
      381,
      'metadata-2431-20261021T090000Z',
      {
        kind: 'supplemental_post_script',
        status: 'completed',
        scan_id: 381,
        vulnerability_id: 829,
        post_script_name: 'PoC Creator',
        archived_at: '2026-10-21T09:00:00Z',
        retention_hours: 5,
        workspace_mode: 'copy',
        archive: { bytes: 1234, files: 7 },
        session_files: ['sessions/.codex/sessions/rollout.jsonl'],
      },
      { 'workspace.tar.gz': 'tarball' }
    );
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'metadata-2433-20261021T100000Z', {
      kind: 'step',
      status: 'completed',
      scan_id: 381,
      vulnerability_id: null,
      archived_at: '2026-10-21T10:00:00Z',
    });
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'metadata-2434-20261021T110000Z.partial', {});
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'not-an-entry', {});
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'metadata-2435-20261021T120000Z', undefined);

    const archives = await listScanArchives(381, { env });

    assert.equal(archives.length, 3);
    assert.deepEqual(
      archives.map((entry) => entry.id),
      ['metadata-2433-20261021T100000Z', 'metadata-2431-20261021T090000Z', 'metadata-2435-20261021T120000Z']
    );
    assert.equal(archives[1].kind, 'supplemental_post_script');
    assert.equal(archives[1].vulnerabilityId, 829);
    assert.equal(archives[1].postScriptName, 'PoC Creator');
    assert.equal(archives[1].bytes, 1234);
    assert.equal(archives[1].workspaceMode, 'copy');
    assert.deepEqual(archives[1].sessionFiles, ['sessions/.codex/sessions/rollout.jsonl']);
    assert.equal(archives[2].incomplete, true);
    assert.deepEqual(await listScanArchives(999, { env }), []);

    // The cap must keep the newest entries, not whichever readdir returned first.
    const capped = await listScanArchives(381, { env, maxEntries: 2 });
    assert.deepEqual(
      capped.map((entry) => entry.id),
      ['metadata-2433-20261021T100000Z', 'metadata-2435-20261021T120000Z']
    );
    assert.deepEqual(await listScanArchives(381, { env, maxEntries: 0 }), []);
    assert.deepEqual(await listScanArchives(381, { env, maxEntries: -1 }), []);
  } finally {
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('summarizeArchiveEntry normalizes legacy transcript paths and drops unsafe ones', () => {
  const summary = summarizeArchiveEntry(
    'metadata-1-20261021T090000Z',
    {
      session_files: [
        '.codex/sessions/2026/rollout.jsonl',
        'sessions/.claude/projects/session.jsonl',
        '.codex/sessions/good/rollout.jsonl',
        '.codex/sessions/../../etc/passwd.jsonl',
        '.codex/sessions/has space.jsonl',
        '../escape.jsonl',
        '.codex/auth.json',
        42,
      ],
    },
    false
  );

  assert.deepEqual(summary.sessionFiles, [
    'sessions/.codex/sessions/2026/rollout.jsonl',
    'sessions/.claude/projects/session.jsonl',
    'sessions/.codex/sessions/good/rollout.jsonl',
  ]);
});

test('listVulnerabilityArchives keeps only manifests for the requested finding', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  try {
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'metadata-1-20261021T090000Z', {
      vulnerability_id: 829,
      archived_at: '2026-10-21T09:00:00Z',
    });
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, 'metadata-2-20261021T100000Z', {
      vulnerability_id: 827,
      archived_at: '2026-10-21T10:00:00Z',
    });

    const archives = await listVulnerabilityArchives(381, 829n, { env });

    assert.equal(archives.length, 1);
    assert.equal(archives[0].id, 'metadata-1-20261021T090000Z');
  } finally {
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('resolveArchiveFile rejects traversal, missing files, and symlink escapes', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  try {
    const directory = await writeArchive(
      env.OPEN_KRITT_ENGINE_DATA_DIR,
      381,
      'metadata-1-20261021T090000Z',
      { scan_id: 381 },
      { 'workspace.tar.gz': 'tarball', 'sessions/.codex/sessions/rollout.jsonl': '{"line":1}\n' }
    );
    const outside = path.join(env.OPEN_KRITT_ENGINE_DATA_DIR, 'outside.jsonl');
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, path.join(directory, 'sessions', '.codex', 'sessions', 'escape.jsonl'));

    const tarball = await resolveArchiveFile(381, 'metadata-1-20261021T090000Z', undefined, { env });
    assert.equal(tarball.path, path.join(directory, 'workspace.tar.gz'));
    assert.equal(tarball.contentType, 'application/gzip');
    assert.equal(tarball.filename, 'workspace.tar.gz');

    const transcript = await resolveArchiveFile(
      381,
      'metadata-1-20261021T090000Z',
      'sessions/.codex/sessions/rollout.jsonl',
      { env }
    );
    assert.equal(transcript.contentType, 'application/x-ndjson; charset=utf-8');

    await assert.rejects(
      resolveArchiveFile(381, 'metadata-1-20261021T090000Z', 'sessions/.codex/sessions/escape.jsonl', { env }),
      ArchiveNotFoundError
    );
    await assert.rejects(resolveArchiveFile(381, '../metadata-1', undefined, { env }), ArchiveNotFoundError);
    await assert.rejects(
      resolveArchiveFile(381, 'metadata-1-20261021T090000Z', '../manifest.json', { env }),
      ArchivePathError
    );
    await assert.rejects(
      resolveArchiveFile(381, 'metadata-1-20261021T090000Z', 'missing.json', { env }),
      ArchivePathError
    );
    await assert.rejects(
      resolveArchiveFile('../381', 'metadata-1-20261021T090000Z', undefined, { env }),
      ArchivePathError
    );
  } finally {
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('resolveArchiveFile rejects symlinked scan and entry directories', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  try {
    const archiveBase = path.join(env.OPEN_KRITT_ENGINE_DATA_DIR, 'workspace-archives');
    const outside = path.join(env.OPEN_KRITT_ENGINE_DATA_DIR, 'outside');
    await mkdir(archiveBase, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'workspace.tar.gz'), 'outside bytes', 'utf8');

    await symlink(outside, path.join(archiveBase, 'scan-382'));
    await mkdir(path.join(archiveBase, 'scan-383'), { recursive: true });
    await symlink(outside, path.join(archiveBase, 'scan-383', 'metadata-1-20261021T090000Z'));
    const realEntry = path.join(archiveBase, 'scan-384', 'metadata-1-20261021T090000Z');
    await mkdir(realEntry, { recursive: true });
    await writeFile(path.join(realEntry, 'workspace.tar.gz'), 'real bytes', 'utf8');
    await writeFile(path.join(outside, 'escape.jsonl'), '{"line":1}\n', 'utf8');
    await symlink(outside, path.join(realEntry, 'sessions'));

    await assert.rejects(
      resolveArchiveFile(382, 'metadata-1-20261021T090000Z', undefined, { env }),
      ArchiveNotFoundError
    );
    await assert.rejects(
      resolveArchiveFile(383, 'metadata-1-20261021T090000Z', undefined, { env }),
      ArchiveNotFoundError
    );
    await assert.rejects(
      resolveArchiveFile(384, 'metadata-1-20261021T090000Z', 'sessions/escape.jsonl', { env }),
      ArchivePathError
    );
  } finally {
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('scan archive routes list entries and stream allowed files', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  const previous = process.env.OPEN_KRITT_ENGINE_DATA_DIR;
  process.env.OPEN_KRITT_ENGINE_DATA_DIR = env.OPEN_KRITT_ENGINE_DATA_DIR;
  const directory = await writeArchive(
    env.OPEN_KRITT_ENGINE_DATA_DIR,
    381,
    'metadata-1-20261021T090000Z',
    {
      kind: 'post_script',
      status: 'completed',
      scan_id: 381,
      vulnerability_id: 829,
      archived_at: '2026-10-21T09:00:00Z',
    },
    {
      'workspace.tar.gz': 'tarball-bytes',
      'README.txt': 'readme',
      'sessions/.codex/sessions/rollout.jsonl': '{"line":1}\n',
    }
  );
  const server = await startServer(env);
  try {
    const listing = await fetch(`${server.origin}/api/scans/381/archives`);
    assert.equal(listing.status, 200);
    const payload = await listing.json();
    assert.equal(payload.archives.length, 1);
    assert.equal(payload.archives[0].vulnerabilityId, 829);

    const download = await fetch(
      `${server.origin}/api/scans/381/archives/metadata-1-20261021T090000Z/file?path=workspace.tar.gz`
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/gzip');
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="workspace.tar.gz"');
    assert.equal(await download.text(), 'tarball-bytes');

    const transcript = await fetch(
      `${server.origin}/api/scans/381/archives/metadata-1-20261021T090000Z/file?path=sessions/.codex/sessions/rollout.jsonl`
    );
    assert.equal(transcript.status, 200);
    assert.equal(transcript.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    assert.equal(await transcript.text(), '{"line":1}\n');

    const traversal = await fetch(
      `${server.origin}/api/scans/381/archives/metadata-1-20261021T090000Z/file?path=../manifest.json`
    );
    assert.equal(traversal.status, 400);

    const missing = await fetch(`${server.origin}/api/scans/381/archives/metadata-9-20261021T090000Z/file`);
    assert.equal(missing.status, 404);
    assert.equal(
      directory,
      path.join(env.OPEN_KRITT_ENGINE_DATA_DIR, 'workspace-archives', 'scan-381', 'metadata-1-20261021T090000Z')
    );
    assert.equal(scanArchiveDirectory(381, { env }), path.dirname(directory));
    assert.equal(archiveRoot(env), path.join(env.OPEN_KRITT_ENGINE_DATA_DIR, 'workspace-archives'));
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.OPEN_KRITT_ENGINE_DATA_DIR;
    else process.env.OPEN_KRITT_ENGINE_DATA_DIR = previous;
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('every summarized session path is accepted by resolveArchiveFile', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  try {
    const entryId = 'metadata-2-20261021T090000Z';
    const manifest = {
      session_files: [
        '.codex/sessions/2026/rollout.jsonl',
        'sessions/.claude/projects/session.jsonl',
        '.codex/sessions/../../etc/passwd.jsonl',
        `.codex/sessions/${'a'.repeat(250)}.jsonl`,
      ],
    };
    await writeArchive(env.OPEN_KRITT_ENGINE_DATA_DIR, 381, entryId, manifest, {
      'sessions/.codex/sessions/2026/rollout.jsonl': '{"line":1}\n',
      'sessions/.claude/projects/session.jsonl': '{"line":2}\n',
    });

    const summary = summarizeArchiveEntry(entryId, manifest, false);
    assert.equal(summary.sessionFiles.length, 2);
    for (const sessionFile of summary.sessionFiles) {
      const resolved = await resolveArchiveFile(381, entryId, sessionFile, { env });
      assert.equal(resolved.contentType, 'application/x-ndjson; charset=utf-8');
    }
  } finally {
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('failed archive streams return sanitized JSON errors', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  const previous = process.env.OPEN_KRITT_ENGINE_DATA_DIR;
  const entryId = 'metadata-3-20261021T090000Z';
  const originalCreateReadStream = fs.createReadStream;
  let server;
  try {
    process.env.OPEN_KRITT_ENGINE_DATA_DIR = env.OPEN_KRITT_ENGINE_DATA_DIR;
    await writeArchive(
      env.OPEN_KRITT_ENGINE_DATA_DIR,
      381,
      entryId,
      { scan_id: 381, archived_at: '2026-10-21T09:00:00Z' },
      { 'workspace.tar.gz': 'tarball-bytes' }
    );
    server = await startServer(env);
    const url = `${server.origin}/api/scans/381/archives/${entryId}/file?path=workspace.tar.gz`;
    const cases = [
      { details: { code: 'ENOENT' }, status: 404, message: 'Archive file not found.' },
      { details: { code: 'EACCES' }, status: 500, message: 'Internal server error.' },
      { details: { status: 404 }, status: 404, message: 'Archive file not found.' },
      { details: { status: 412 }, status: 412, message: 'Precondition failed.' },
      {
        details: { status: 416, headers: { 'Content-Range': 'bytes */13' } },
        status: 416,
        message: 'Requested range not satisfiable.',
        contentRange: 'bytes */13',
      },
    ];

    for (const testCase of cases) {
      fs.createReadStream = () => {
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.destroy(Object.assign(new Error('stream failed'), testCase.details)));
        return stream;
      };
      const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
      assert.equal(response.status, testCase.status, JSON.stringify(testCase.details));
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(response.headers.get('content-disposition'), null);
      assert.equal(response.headers.get('accept-ranges'), null);
      assert.equal(response.headers.get('last-modified'), null);
      assert.equal(response.headers.get('content-range'), testCase.contentRange ?? null);
      const text = await response.text();
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
      assert.equal(JSON.parse(text).error, testCase.message);
    }

    fs.createReadStream = () => {
      const stream = new Readable({ read() {} });
      process.nextTick(() => stream.destroy(Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' })));
      return stream;
    };
    await assert.rejects(fetch(url));
  } finally {
    fs.createReadStream = originalCreateReadStream;
    if (server) await server.close();
    if (previous === undefined) delete process.env.OPEN_KRITT_ENGINE_DATA_DIR;
    else process.env.OPEN_KRITT_ENGINE_DATA_DIR = previous;
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});

test('unsatisfiable archive ranges return 416 with Content-Range', async () => {
  const env = { OPEN_KRITT_ENGINE_DATA_DIR: await makeArchiveRoot() };
  const previous = process.env.OPEN_KRITT_ENGINE_DATA_DIR;
  const entryId = 'metadata-4-20261021T090000Z';
  let server;
  try {
    process.env.OPEN_KRITT_ENGINE_DATA_DIR = env.OPEN_KRITT_ENGINE_DATA_DIR;
    await writeArchive(
      env.OPEN_KRITT_ENGINE_DATA_DIR,
      381,
      entryId,
      { scan_id: 381, archived_at: '2026-10-21T09:00:00Z' },
      { 'workspace.tar.gz': 'tarball-bytes' }
    );
    server = await startServer(env);

    const response = await fetch(`${server.origin}/api/scans/381/archives/${entryId}/file?path=workspace.tar.gz`, {
      headers: { Range: 'bytes=999999-' },
    });

    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match(response.headers.get('content-range'), /^bytes \*\//);
    assert.equal((await response.json()).error, 'Requested range not satisfiable.');
  } finally {
    if (server) await server.close();
    if (previous === undefined) delete process.env.OPEN_KRITT_ENGINE_DATA_DIR;
    else process.env.OPEN_KRITT_ENGINE_DATA_DIR = previous;
    await rm(env.OPEN_KRITT_ENGINE_DATA_DIR, { recursive: true, force: true });
  }
});
