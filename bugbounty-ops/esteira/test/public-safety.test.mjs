import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprint } from '../lib/sweep.mjs';
import { candidatesFromSurface } from '../lib/deepen.mjs';
import { classifyObservedImpact } from '../lib/impact-gate.mjs';

test('rejects discovered paths outside the declared prefix', () => {
  const target = { assets: [{ asset: 'https://example.test/allowed/*' }] };
  const hosts = { seed: { status: 200, url: 'https://example.test/allowed/', endpoints: ['/outside', '/allowed/resource'] } };
  assert.deepEqual(candidatesFromSurface({ hosts }, { target }), ['https://example.test/allowed/resource']);
});

test('does not follow an out-of-scope redirect', async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://outside.test/' } });
  };
  try {
    const url = 'https://example.test/allowed/';
    await fingerprint(url, { allows: (candidate) => candidate === url });
    assert.deepEqual(calls, [url]);
  } finally { globalThis.fetch = previous; }
});

test('bare successful status is not evidence of access', () => {
  assert.equal(classifyObservedImpact({ steps: [{ phase: 'attack', response: { status: 200 } }] }).access, false);
});

test('the scope guard can be preloaded by a Node subprocess', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofrail-preload-'));
  const scope = path.join(dir, 'scope.json');
  writeFileSync(scope, JSON.stringify({ capturedAt: new Date().toISOString(), assets: [{ asset: 'https://example.test/*' }] }));
  const guard = pathToFileURL(path.resolve(import.meta.dirname, '../lib/replay-fetch-guard.mjs')).href;
  const result = spawnSync(process.execPath, ['--import', guard, '-e', 'process.stdout.write("ready")'], {
    encoding: 'utf8', env: { ...process.env, ESTEIRA_CAPTURED_SCOPE: scope },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ready');
});
