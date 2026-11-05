import fs from 'node:fs';
import { scopePolicy } from './scope-policy.mjs';

const scope = JSON.parse(fs.readFileSync(process.env.ESTEIRA_CAPTURED_SCOPE, 'utf8'));
const captured = Date.parse(scope.capturedAt);
const age = Date.now() - captured;
if (!Number.isFinite(age) || age < 0 || age > 7 * 86400000) throw new Error('Invalid or stale captured scope');
const allows = scopePolicy(scope);
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!allows(url)) throw new Error('Request outside captured scope');
  return fetch(input, { ...init, redirect: 'manual' });
};
