// backend/src/lib/severity.js is a copy of frontend/src/lib/severity.js, because the
// backend container mounts only ./backend and cannot import across the package
// boundary. A copy that drifts is exactly the bug this module was extracted to fix:
// three hand-written severity maps that disagreed, so the same finding could read as
// "Critical" in the UI and as nothing at all on the share card.
//
// Two layers guard it. The text comparison catches any edit at all, including one no
// behavioural case covers. The behavioural comparison catches a semantic divergence
// and says which input differs, which is what makes a failure actionable.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendModule = join(repoRoot, 'backend', 'src', 'lib', 'severity.js');
const frontendModule = join(repoRoot, 'frontend', 'src', 'lib', 'severity.js');

// Line comments are the one thing the copies are expected to differ in: each explains
// its own side of the boundary. Everything else must match character for character.
function normalized(contents) {
  return contents
    .replace(/^\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('the two severity copies are identical apart from their headers', async () => {
  const [backend, frontend] = await Promise.all([readFile(backendModule, 'utf8'), readFile(frontendModule, 'utf8')]);

  assert.equal(
    normalized(backend),
    normalized(frontend),
    'backend/src/lib/severity.js has drifted from frontend/src/lib/severity.js — apply the same change to both'
  );
});

test('the two severity copies agree on real inputs', async () => {
  const [backend, frontend] = await Promise.all([
    import(pathToFileURL(backendModule).href),
    import(pathToFileURL(frontendModule).href),
  ]);

  const inputs = [
    'Critical',
    'Critical ',
    '  high',
    'Info',
    'info',
    'informational',
    'Critical — secret/repository src/auth.js',
    'CVSS 9.8 (Critical)',
    'Severity: Medium',
    'High severity, but only exploitable on testnet',
    'Not exploitable — informational',
    'sev-low',
    '7.5',
    '9.8',
    '0.0',
    'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    'highlighted',
    'lowest priority cleanup',
    'unknown',
    'N/A',
    '',
    null,
    undefined,
    42,
  ];

  for (const input of inputs) {
    const label = JSON.stringify(input);
    assert.equal(backend.severityLevel(input), frontend.severityLevel(input), `severityLevel differs on ${label}`);
    assert.equal(backend.severityColor(input), frontend.severityColor(input), `severityColor differs on ${label}`);
  }

  for (const level of [...backend.CANONICAL_SEVERITY_LEVELS, 'informational', null]) {
    assert.equal(
      backend.severityShareLabel(level),
      frontend.severityShareLabel(level),
      `severityShareLabel differs on ${JSON.stringify(level)}`
    );
  }
});

test('the copies agree on their exported tables', async () => {
  const [backend, frontend] = await Promise.all([
    import(pathToFileURL(backendModule).href),
    import(pathToFileURL(frontendModule).href),
  ]);

  assert.deepEqual(backend.CANONICAL_SEVERITY_LEVELS, frontend.CANONICAL_SEVERITY_LEVELS);
  assert.deepEqual(backend.SEVERITY_COLORS, frontend.SEVERITY_COLORS);
  assert.deepEqual(backend.SEVERITY_DISPLAY_LABELS, frontend.SEVERITY_DISPLAY_LABELS);
});
