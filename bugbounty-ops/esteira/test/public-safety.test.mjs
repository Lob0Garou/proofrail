import test from 'node:test';
import assert from 'node:assert/strict';
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
