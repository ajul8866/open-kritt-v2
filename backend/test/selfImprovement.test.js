import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';

import {
  assertApprovedWorkflow,
  boundedEvidence,
  canonicalJson,
  workflowSnapshot,
} from '../src/lib/improvementEvidence.js';
import { createSelfImprovementRouter } from '../src/routes/selfImprovement.js';
import { REQUIRED_KEY_TYPES, REQUIRED_VULN_KEYS } from '../src/lib/constants.js';
import { validateWorkflow } from '../src/lib/validation.js';

function fixture() {
  return {
    workflow: { id: 1n, name: 'Baseline', description: 'Original workflow' },
    steps: [
      {
        id: 10n,
        name: 'Investigate',
        content: 'Inspect {{repo_full}} for evidence-backed bugs.',
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        boundSourceStepId: null,
        outputFormat: JSON.stringify(
          Object.fromEntries(REQUIRED_VULN_KEYS.map((key) => [key, REQUIRED_KEY_TYPES[key]]))
        ),
      },
    ],
  };
}

test('snapshot hashes are independent of object key ordering and accepted by workflow validation', () => {
  const { workflow, steps } = fixture();
  const snapshot = workflowSnapshot(workflow, steps);
  assert.equal(validateWorkflow(snapshot).maxDepth, 0);
  const hash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  assertApprovedWorkflow(hash, workflow, steps);
  const reordered = { levels: snapshot.levels, description: snapshot.description, name: snapshot.name };
  assert.equal(canonicalJson(snapshot), canonicalJson(reordered));
  assert.throws(() => assertApprovedWorkflow('not-a-digest', workflow, steps), /Validation failed/);
  assert.throws(
    () => assertApprovedWorkflow(hash, workflow, [{ ...steps[0], content: 'Changed after approval' }]),
    /Validation failed/
  );
});

test('guard rejects bound routing rather than ignoring its semantics', () => {
  const { workflow, steps } = fixture();
  assert.throws(() => workflowSnapshot(workflow, [{ ...steps[0], boundSourceStepId: 2n }]), /Validation failed/);
});

test('evidence clipping bounds long strings and deeply nested metadata', () => {
  assert.equal(boundedEvidence(42n), '42');
  assert.equal(boundedEvidence('x'.repeat(2000)).length, 1012);
  assert.equal(boundedEvidence(Array.from({ length: 30 }, () => 1)).length, 20);
  assert.match(JSON.stringify(boundedEvidence({ a: { b: { c: { d: { secret: true } } } } })), /omitted/);
});

test('read-only evidence endpoint covers empty scans and exposes bounded persisted logs', async () => {
  let queried;
  const router = createSelfImprovementRouter({
    prismaClient: {
      scan: {
        findUnique: async ({ where }) =>
          where.id === 10n ? { id: 10n, status: 'completed', reasoning: { message: 'No findings' } } : null,
      },
      stepMetadata: {
        findMany: async (args) => {
          queried = args;
          return [
            {
              id: 1n,
              stepId: 2n,
              status: 'failed',
              kind: 'step',
              phase: 'output_validation',
              error: 'x'.repeat(5000),
              stubExplanation: null,
              checkedOutCommit: 'a'.repeat(40),
              runTimeMs: 123n,
            },
          ];
        },
        count: async () => 201,
      },
    },
  });
  const app = express();
  app.use('/api/self-improvement', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const root = `http://127.0.0.1:${server.address().port}/api/self-improvement`;
    const response = await fetch(`${root}/scans/10/evidence`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.scanId, '10');
    assert.equal(body.truncated, true);
    assert.equal(body.jobs[0].id, '1');
    assert.equal(body.jobs[0].runTimeMs, '123');
    assert.match(body.jobs[0].error, /truncated/);
    assert.equal(queried.take, 200);
    assert.equal(queried.select.promptFilled, undefined);
    assert.equal(queried.select.codexAccountEmail, undefined);
    assert.equal((await fetch(`${root}/scans/99/evidence`)).status, 404);
    assert.equal((await fetch(`${root}/scans/10/evidence`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
