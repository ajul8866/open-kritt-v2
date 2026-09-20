// The engine service lists its environment explicitly instead of using env_file, so a
// value placed in .env only reaches the container when docker-compose.yml passes it
// through. Without this, setting TYPESAFE_API_KEY in .env silently does nothing and the
// engine stays deterministic while the operator believes judgment is enabled.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readCompose() {
  return readFile(join(repoRoot, 'docker-compose.yml'), 'utf8');
}

// Returns the body of one top-level service block, up to the next service.
function serviceBlock(compose, name) {
  const start = compose.indexOf(`\n  ${name}:`);
  assert.notEqual(start, -1, `service ${name} not found in docker-compose.yml`);
  const rest = compose.slice(start + 1);
  const nextService = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return nextService === -1 ? rest : rest.slice(0, nextService + 1);
}

test('the engine service passes the TypeSafe judgment variables through', async () => {
  const engine = serviceBlock(await readCompose(), 'engine');

  assert.match(engine, /TYPESAFE_API_KEY: \$\{TYPESAFE_API_KEY:-\}/);
  assert.match(engine, /TYPESAFE_MODEL: \$\{TYPESAFE_MODEL:-\}/);
});

test('judgment credentials reach only the engine, not the other services', async () => {
  const compose = await readCompose();

  for (const service of ['frontend', 'backend', 'executor-view', 'db']) {
    assert.doesNotMatch(
      serviceBlock(compose, service),
      /TYPESAFE_API_KEY/,
      `${service} must not receive the judgment key`
    );
  }
});

test('.env.example documents the judgment variables as optional and offline by default', async () => {
  const example = await readFile(join(repoRoot, '.env.example'), 'utf8');

  assert.match(example, /^TYPESAFE_API_KEY=$/m);
  assert.match(example, /^TYPESAFE_MODEL=$/m);
  // The egress boundary is the whole reason this is opt-in; keep it stated.
  assert.match(example, /never repository content/i);
});

test('the compose passthrough keeps the empty default so scans stay offline by default', async () => {
  const engine = serviceBlock(await readCompose(), 'engine');

  // `${VAR:-}` resolves to an empty string when unset, which judgment.available()
  // treats as "not configured" rather than passing an empty credential along.
  assert.doesNotMatch(engine, /TYPESAFE_API_KEY: \$\{TYPESAFE_API_KEY:-[^}]+\}/);
});
