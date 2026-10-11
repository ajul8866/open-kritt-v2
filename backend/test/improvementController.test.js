import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { improvementControllerClient } from '../src/lib/improvementController.js';
import { createSelfImprovementRouter } from '../src/routes/selfImprovement.js';

test('controller client authenticates internally and never follows redirects or retries POST', async () => {
  let calls = 0;
  const client = improvementControllerClient({
    url: 'http://private-controller:8091',
    readToken: async () => 'a'.repeat(64),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'http://private-controller:8091/scans/10/loop');
      assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      throw new Error('Response lost');
    },
  });
  await assert.rejects(() => client('/scans/10/loop', { method: 'POST', body: { config: {} } }), /Response lost/);
  assert.equal(calls, 1);
});

test('browser routes forward exact approval and review bodies and reject path injection', async () => {
  const calls = [];
  const lid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const app = express();
  app.use(express.json());
  app.use(
    '/api/self-improvement',
    createSelfImprovementRouter({
      controller: async (path, options) => {
        calls.push({ path, ...options });
        return { status: 200, body: { loop: { id: lid, state: 'awaiting_approval' } } };
      },
    })
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}/api/self-improvement`;
  try {
    const body = { digest: 'b'.repeat(64), reviewer: 'operator', reviewed: true };
    const response = await fetch(`${root}/loops/${lid}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[0], { path: `/loops/${lid}/approval`, method: 'POST', body });
    assert.equal((await fetch(`${root}/scans/not-an-id/loop`)).status, 422);
    assert.equal((await fetch(`${root}/loops/not-a-uuid`)).status, 422);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(await response.json()).includes('Bearer'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unavailable controller returns an actionable response without exposing tokens', async () => {
  const app = express();
  app.use(
    '/api/self-improvement',
    createSelfImprovementRouter({
      controller: async () => {
        throw new Error('private-token');
      },
    })
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/self-improvement/scans/10/loop`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /controller service is running/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
