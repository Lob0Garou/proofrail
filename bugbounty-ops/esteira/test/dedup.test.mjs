import test from 'node:test';
import assert from 'node:assert/strict';
import { dupScore, DEDUP, assetFreshness } from '../lib/dedup.mjs';

const base = { reports90d: 0, resolved: 0, eligibleAssets: 10, newestAssetAgeDays: null };

test('programa morto, sem relatório: risco muito baixo', () => {
  const r = dupScore({ ...base, reports90d: 0, resolved: 0 });
  assert.equal(r.risk, 0);
  assert.equal(r.band, 'muito baixo');
});

test('saturação sozinha não estoura: 1000 resolvidos = 30 pontos', () => {
  const r = dupScore({ ...base, reports90d: 0, resolved: 1000 });
  assert.equal(r.parts.resolvedPart, 30);
  assert.equal(r.risk, 30);
});

test('pressão alta soma: 20 relatórios por ativo em 90d = 40 pontos', () => {
  const r = dupScore({ ...base, reports90d: 200, eligibleAssets: 10, resolved: 0 });
  assert.equal(r.parts.pressure, 20);
  assert.equal(r.parts.pressurePart, 40);
});

test('ativo novo desconta risco (é o ponto do usuário: escopo atualizado importa)', () => {
  const velho = dupScore({ ...base, reports90d: 200, eligibleAssets: 10, resolved: 400, newestAssetAgeDays: 900 });
  const novo = dupScore({ ...base, reports90d: 200, eligibleAssets: 10, resolved: 400, newestAssetAgeDays: 10 });
  assert.ok(novo.risk < velho.risk);
});

test('programa saturado MAS com ativo novo fica mais barato que programa saturado velho', () => {
  const saturadoVelho = dupScore({ reports90d: 300, eligibleAssets: 10, resolved: 1000, newestAssetAgeDays: 1200 });
  const saturadoNovo = dupScore({ reports90d: 300, eligibleAssets: 10, resolved: 1000, newestAssetAgeDays: 15 });
  assert.ok(saturadoNovo.risk <= saturadoVelho.risk);
  assert.ok(saturadoNovo.parts.freshPart > saturadoVelho.parts.freshPart);
});

test('sem data de ativo o risco não ganha alívio e a lacuna é declarada', () => {
  const r = dupScore({ ...base, reports90d: 200, eligibleAssets: 10, resolved: 400, newestAssetAgeDays: null });
  assert.equal(r.parts.freshPart, 0);
  assert.ok(r.unknown.includes('newestAssetAgeDays'));
});

test('risco nunca sai de 0..100', () => {
  const r = dupScore({ reports90d: 999999, eligibleAssets: 1, resolved: 999999, newestAssetAgeDays: 1 });
  assert.ok(r.risk >= 0 && r.risk <= 100);
});

test('eligibleAssets 0 não divide por zero', () => {
  const r = dupScore({ ...base, eligibleAssets: 0, reports90d: 10 });
  assert.equal(r.parts.pressure, 10);
});

test('assetFreshness acha o ativo mais novo e conta os de 30 dias', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const assets = [
    { created_at: '2018-01-11T00:00:00Z' },
    { created_at: '2026-10-22T00:00:00Z' },
    { created_at: '2026-11-01T00:00:00Z' },
    { created_at: null },
  ];
  const f = assetFreshness(assets, now);
  assert.equal(f.newestAssetAgeDays, 4);
  assert.equal(f.newAssets30d, 2);
  assert.equal(f.datedCount, 3);
  assert.equal(f.total, 4);
});

test('assetFreshness sem data devolve null, não zero', () => {
  const f = assetFreshness([{ created_at: null }, {}]);
  assert.equal(f.newestAssetAgeDays, null);
  assert.equal(f.newAssets30d, 0);
});

test('pesos somam 100', () => {
  assert.equal(DEDUP.W_PRESSURE + DEDUP.W_RESOLVED + DEDUP.W_FRESH, 100);
});

test('sinal todo ausente NÃO vira risco baixo: vira indeterminado', () => {
  const r = dupScore({ reports90d: null, resolved: null, eligibleAssets: 69, newestAssetAgeDays: null });
  assert.equal(r.coverage, 0);
  assert.equal(r.band, 'indeterminado');
});

test('cobertura 40% ainda é indeterminado (só saturação conhecida)', () => {
  const r = dupScore({ reports90d: null, resolved: 500, eligibleAssets: 6, newestAssetAgeDays: null });
  assert.equal(r.coverage, 0.3);
  assert.equal(r.band, 'indeterminado');
});

test('cobertura 70% (pressão + saturação) volta a dar banda', () => {
  const r = dupScore({ reports90d: 10, resolved: 50, eligibleAssets: 10, newestAssetAgeDays: null });
  assert.equal(r.coverage, 0.7);
  assert.notEqual(r.band, 'indeterminado');
});
