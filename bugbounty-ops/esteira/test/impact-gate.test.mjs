import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservedImpact, gateBanner } from '../lib/impact-gate.mjs';

const step = (phase, status) => ({ phase, response: { status } });

test('anonymous attack with protected content and valid controls proves access', () => {
  const g = classifyObservedImpact({
    schema: 'replay-result/v2', verdict: 'proven', oracle: 'auth-matrix',
    reason: 'anon-reached-authed-resource', impact_basis: 'auth-bypass',
    steps: [step('positive', 200), step('negative', 401), {
      phase: 'attack', request: { url: 'https://example.test/resource', headers: {} },
      response: { status: 200, body: 'protected marker' },
    }],
  });
  assert.equal(g.level, 'access-proven');
  assert.equal(g.access, true);
  assert.equal(g.status, 200);
});

test('401 no controle e 400 no ataque = boundary-crossed, sem acesso', () => {
  const g = classifyObservedImpact({ steps: [step('positive', 401), step('attack', 400)] });
  assert.equal(g.level, 'boundary-crossed');
  assert.equal(g.access, false);
  assert.match(g.reason, /NENHUM recurso protegido/);
});

test('mesmo status em controle e ataque = blocked', () => {
  const g = classifyObservedImpact({ steps: [step('positive', 403), step('attack', 403)] });
  assert.equal(g.level, 'blocked');
  assert.equal(g.access, false);
});

test('sem passos = no-proof', () => {
  assert.equal(classifyObservedImpact(null).level, 'no-proof');
  assert.equal(classifyObservedImpact({}).level, 'no-proof');
  assert.equal(classifyObservedImpact({ steps: [] }).level, 'no-proof');
  assert.equal(classifyObservedImpact({ steps: [{ phase: 'attack' }] }).level, 'no-proof', 'passo sem response nao conta');
});

test('second control: 401 -> 400 deve ser boundary-crossed, nunca acesso', () => {
  const g = classifyObservedImpact({
    steps: [
      { phase: 'positive', response: { status: 401 } },
      { phase: 'attack', response: { status: 400 } },
      { phase: 'confound', response: { status: 404 } },
      { phase: 'negative', response: { status: 401 } },
    ],
  });
  assert.equal(g.level, 'boundary-crossed');
  assert.equal(g.access, false);
});

test('banner existe para todo nivel sem acesso', () => {
  for (const level of ['boundary-crossed', 'blocked', 'no-proof']) {
    const b = gateBanner({ level, access: false });
    assert.ok(b && b.length > 40, `banner fraco para ${level}`);
  }
  assert.equal(gateBanner({ level: 'access-proven', access: true }), null);
});

test('bare 2xx responses lack evidence', () => {
  assert.equal(classifyObservedImpact({ steps: [step('attack', 204)] }).access, false);
  assert.equal(classifyObservedImpact({ steps: [step('attack', 206)] }).access, false);
});

test('3xx NAO e acesso (redirect nao serve recurso)', () => {
  const g = classifyObservedImpact({ steps: [step('positive', 401), step('attack', 302)] });
  assert.equal(g.access, false);
  assert.equal(g.level, 'boundary-crossed', '302 != 401 entra como atravessou-e-travou');
});
