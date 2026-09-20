// The backend runs inside a container that mounts only ./backend at /app, so a module
// under backend/src that imports across the package boundary resolves to a path that
// does not exist there. That is not a lint nit: the process fails to start, the
// backend container exits, and the frontend's proxy to `backend` fails with EAI_AGAIN.
//
// scripts/ can import from ../frontend because it runs from the repo root on the host.
// backend/ cannot, and this test holds that line.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(backendRoot, 'src');

async function javascriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await javascriptFiles(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

// Matches `from '...'` and bare `import '...'` for relative specifiers only.
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s+)['"](\.[^'"]+)['"]/g;

test('no backend source file imports across the package boundary', async () => {
  const offenders = [];

  for (const file of await javascriptFiles(sourceRoot)) {
    const contents = await readFile(file, 'utf8');
    for (const match of contents.matchAll(RELATIVE_IMPORT_RE)) {
      const specifier = match[1];
      const resolved = resolve(dirname(file), specifier);
      // A specifier that resolves above backend/ would land outside /app in the
      // container, where nothing is mounted.
      if (relative(backendRoot, resolved).startsWith('..')) {
        offenders.push(`${relative(backendRoot, file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `these imports escape the backend package: ${offenders.join(', ')}`);
});

test('the backend owns a severity module rather than reaching into the frontend', async () => {
  const contents = await readFile(join(sourceRoot, 'lib', 'severity.js'), 'utf8');
  assert.match(contents, /export function severityLevel/);
  assert.match(contents, /export function severityColor/);
});
