import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseTier, meetsMin, severityFromSpec, sortCandidates, tierLabel, tierRank } from '../lib/severity.mjs';
import {
  slugFromToken, inspectScope, resolveEngagement, objectiveState, listEngagements,
  engagementDir, engagementFiles,
} from '../lib/engagement.mjs';
import { emitSubmits, writeSubmitIndex, renderSubmitIndex, groupCandidates, markSubmitted, submitId } from '../lib/submits.mjs';
import { compareProbe, candidatesFromSurface } from '../lib/deepen.mjs';
import { renderStatus } from '../lib/status.mjs';
import { emptyState, tally } from '../lib/state.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const fresh = '2026-11-05T02:00:00Z';

const scopeOk = (over = {}) => ({
  platform: 'bugcrowd', slug: 'alvo', capturedAt: fresh,
  assets: [{ asset: 'https://www.alvo.com/empleados/*', type: 'api', eligible: true }],
  rewards: { P3: ['$300', '$750'] },
  ...over,
});

// ---------------------------------------------------------------- severidade
test('piso e PISO: P1 e P2 passam de P3, P4 e P5 nao', () => {
  assert.equal(meetsMin('P1', 'P3'), true);
  assert.equal(meetsMin('P2', 'P3'), true);
  assert.equal(meetsMin('P3', 'P3'), true);
  assert.equal(meetsMin('P4', 'P3'), false);
  assert.equal(meetsMin('P5', 'P3'), false);
});

test('severidade ausente nunca atinge o piso — nao inventa faixa', () => {
  assert.equal(meetsMin(null, 'P3'), false);
  assert.equal(meetsMin('p3 ', 'p3'), true);
  assert.equal(meetsMin('T3', 'P3'), false);
  assert.equal(tierRank('P1') < tierRank('P5'), true);
});

test('severidade vem da spec, aceitando severity ou vrt', () => {
  assert.equal(severityFromSpec({ severity: 'p2' }), 'P2');
  assert.equal(severityFromSpec({ vrt: 'P4' }), 'P4');
  assert.equal(severityFromSpec({}), null);
});

test('candidato mais grave primeiro; sem severidade por ultimo', () => {
  const s = sortCandidates([{ severity: null, at: '1' }, { severity: 'P4', at: '2' }, { severity: 'P1', at: '3' }]);
  assert.deepEqual(s.map((x) => x.severity), ['P1', 'P4', null]);
});

test('empate de severidade: prova mais recente na frente', () => {
  const s = sortCandidates([{ severity: 'P3', at: '2026-11-05T01:00:00Z' }, { severity: 'P3', at: '2026-11-05T09:00:00Z' }]);
  assert.equal(s[0].at, '2026-11-05T09:00:00Z');
});

test('rotulo usa a faixa do escopo quando existe', () => {
  assert.equal(tierLabel('P3', { P3: ['$300', '$750'] }), 'P3 ($300–$750)');
  assert.equal(tierLabel('P5', { P5: [null, null] }), 'P5 (sem recompensa declarada)');
  assert.equal(tierLabel(null, {}), 'severidade não declarada');
});

// ------------------------------------------------------------------ anexo
test('slug sai de slug puro, prefixo de plataforma e caminho de escopo', () => {
  assert.equal(slugFromToken('example-program'), 'example-program');
  assert.equal(slugFromToken('bugcrowd-example-program'), 'example-program');
  assert.equal(slugFromToken('bugbounty-ops/scopes/bugcrowd-example-program/scope.json'), 'example-program');
  assert.equal(slugFromToken('bugbounty-ops/scopes/bugcrowd-example-program/'), 'example-program');
  assert.equal(slugFromToken(''), null);
});

test('escopo completo passa na inspecao', () => {
  const r = inspectScope(scopeOk(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.slug, 'alvo');
});

test('escopo sem data, sem ativo ou velho e recusado com o motivo exato', () => {
  assert.match(inspectScope(scopeOk({ capturedAt: null }), NOW).problems.join(' '), /capturedAt/);
  assert.match(inspectScope(scopeOk({ assets: [] }), NOW).problems.join(' '), /sem ativo/);
  assert.match(inspectScope(scopeOk({ capturedAt: '2026-10-01T00:00:00Z' }), NOW).problems.join(' '), /7 dias/);
  assert.match(inspectScope(scopeOk({ platform: 'facebook' }), NOW).problems.join(' '), /plataforma fora/);
});

test('resolucao: alvo explicito vence, unico engajamento e aceito, ambiguidade acusa', () => {
  const est = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  assert.match(resolveEngagement(est, 'x').dir, /engagements[\\/]x$/);
  fs.mkdirSync(engagementDir(est, 'a'), { recursive: true });
  fs.writeFileSync(path.join(engagementDir(est, 'a'), 'focus.json'), '{}');
  assert.equal(resolveEngagement(est, null).slug, 'a');
  fs.mkdirSync(engagementDir(est, 'b'), { recursive: true });
  fs.writeFileSync(path.join(engagementDir(est, 'b'), 'focus.json'), '{}');
  assert.match(resolveEngagement(est, null).error, /passe --target/);
  assert.deepEqual(listEngagements(est), ['a', 'b']);
});

test('arquivos de controle de dois alvos nao colidem', () => {
  const est = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const a = engagementFiles(engagementDir(est, 'a'));
  const b = engagementFiles(engagementDir(est, 'b'));
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.submit, b.submit);
});

// ---------------------------------------------------------------- objetivo
const stateCom = (cands) => {
  const st = emptyState('r');
  st.focus = { slug: 'alvo', min: 'P3' };
  st.targets.alvo = { status: 'pending', candidates: cands };
  tally(st);
  return st;
};

test('objective stays open without recorded evidence', () => {
  assert.equal(objectiveState(stateCom([{ verdict: 'proven', severity: 'P2' }]), 'P3').met, false);
  assert.equal(objectiveState(stateCom([{ verdict: 'proven', severity: 'P4' }]), 'P3').met, false);
  assert.equal(objectiveState(stateCom([{ verdict: 'not-proven', severity: 'P1' }]), 'P3').met, false);
});

test('proven sem severidade nao fecha o objetivo: a pauta e declarar o tier', () => {
  const o = objectiveState(stateCom([{ verdict: 'proven', severity: null }]), 'P3');
  assert.equal(o.met, false);
  assert.equal(o.provadosSemTier.length, 1);
  assert.match(o.faltando.join(' '), /severity/);
});

test('submit: um documento por achado, com severidade e prova', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{
    verdict: 'proven', severity: 'P2', hypothesis: 'BOLA no objeto', oracle: 'differential-read',
    artifact: 'resultados/replay/x/result.json', spec: 'scripts/replay-alvo.json',
  }]);
  const subs = emitSubmits(dir, { focus: { slug: 'alvo', platform: 'bugcrowd' }, state: st, min: 'P3', rewards: { P2: ['$1k'] } });
  assert.equal(subs.length, 1);
  const md = fs.readFileSync(subs[0].path, 'utf8');
  assert.match(md, /P2 \(\$1k\)/);
  assert.match(md, /result\.json/);
  assert.match(md, /BOLA no objeto/);
  // Gate duro: prova sem passos gravados NAO e submetivel — o documento declara
  // o gate e o INDEX marca SEGURAR em vez de "novo".
  assert.match(md, /NAO SUBMETIVEL/);
  assert.match(md, /gate de impacto: `no-proof`/);
  assert.equal(subs[0].gate.access, false);
  assert.equal(subs[0].gate.level, 'no-proof');
});

test('submit com 2xx anonimo no ataque passa o gate e pede tier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-ok-'));
  const prova = path.join(dir, 'prova');
  fs.mkdirSync(prova);
  fs.writeFileSync(path.join(prova, 'result.json'), JSON.stringify({
    schema: 'replay-result/v2', oracle: 'differential-read',
    verdict: 'proven', reason: 'reached-object-of-positive', impact_basis: 'read',
    steps: [
      { phase: 'positive', response: { status: 401 } },
      { phase: 'attack', response: { status: 200 } },
      { phase: 'negative', response: { status: 403 } },
    ],
  }));
  const st = stateCom([{
    verdict: 'proven', severity: 'P2', hypothesis: 'BOLA no objeto', oracle: 'differential-read',
    artifact: prova + path.sep, spec: 'scripts/replay-alvo.json',
  }]);
  const subs = emitSubmits(dir, { focus: { slug: 'alvo', platform: 'bugcrowd' }, state: st, min: 'P3' });
  const md = fs.readFileSync(subs[0].path, 'utf8');
  assert.equal(subs[0].gate.access, true);
  assert.equal(objectiveState(st, 'P3').met, true);
  assert.doesNotMatch(md, /NAO SUBMETIVEL/);
  assert.match(md, /the judge returned `proven`/);
});

test('dois P2 independentes + um P3 = tres documentos, nao um relatorio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([
    { verdict: 'proven', severity: 'P2', hypothesis: 'A1', artifact: 'a/result.json', spec: 'a.json' },
    { verdict: 'proven', severity: 'P2', hypothesis: 'A2', artifact: 'b/result.json', spec: 'b.json' },
    { verdict: 'proven', severity: 'P3', hypothesis: 'A3', artifact: 'c/result.json', spec: 'c.json' },
  ]);
  const subs = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' });
  assert.equal(subs.length, 3);
  assert.deepEqual(subs.map((s) => s.severity), ['P2', 'P2', 'P3']);
  const idx = writeSubmitIndex(dir, subs, { min: 'P3' });
  assert.match(fs.readFileSync(idx, 'utf8'), /3|`p2-a1|p2-a2/);
});

test('achado abaixo do piso sai igual, marcado como abaixo do piso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{ verdict: 'proven', severity: 'P4', hypothesis: 'fraco', artifact: 'd/result.json' }]);
  const subs = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].below, true);
  assert.match(fs.readFileSync(subs[0].path, 'utf8'), /abaixo do piso P3/);
});

test('chain declarado agrupa elos num submit so', () => {
  const st = stateCom([
    { verdict: 'proven', severity: 'P3', hypothesis: 'elo 1', chain: 'cadeia-x', artifact: '1/r.json' },
    { verdict: 'proven', severity: 'P2', hypothesis: 'elo 2', chain: 'cadeia-x', artifact: '2/r.json' },
  ]);
  const g = groupCandidates(st.targets.alvo.candidates);
  assert.equal(g.length, 1);
  assert.equal(g[0].severity, 'P2');
  assert.equal(g[0].members.length, 2);
});

test('documento no padrao do formulario: passo numerado, impacto separado, VRT em branco', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  fs.writeFileSync(path.join(art, 'result.json'), JSON.stringify({
    schema: 'replay-result/v2', program: 'alvo', hypothesis: 'BOLA no objeto',
    oracle: 'differential-read', verdict: 'proven', reason: 'reached-object-of-positive',
    impact_basis: 'read',
    steps: [
      { id: 'pos', phase: 'positive', identity: 'A', request: { method: 'GET', url: 'http://t/obj/1' }, response: { status: 200 } },
      { id: 'atk', phase: 'attack', identity: 'B', request: { method: 'GET', url: 'http://t/obj/1' }, response: { status: 200 } },
    ],
  }));
  fs.writeFileSync(path.join(art, 'exchange-01.req.txt'), 'GET /obj/1\n');
  fs.writeFileSync(path.join(art, 'exchange-01.res.txt'), 'HTTP/1.1 200\n');
  fs.writeFileSync(path.join(art, 'exchange-02.req.txt'), 'GET /obj/1\n');
  fs.writeFileSync(path.join(art, 'exchange-02.res.txt'), 'HTTP/1.1 200\n');
  const st = stateCom([{
    verdict: 'proven', severity: 'P2', hypothesis: 'BOLA no objeto', oracle: 'differential-read',
    artifact: path.join(art, 'result.json'), spec: 'scripts/replay-alvo.json',
  }]);
  const md = fs.readFileSync(emitSubmits(dir, { focus: { slug: 'alvo', platform: 'bugcrowd' }, state: st, min: 'P3' })[0].path, 'utf8');
  assert.match(md, /^# BOLA no objeto\n/);
  assert.match(md, /VRT:\*\* _não preenchido/);
  assert.match(md, /Severity request/);
  assert.match(md, /1\. \*\*controle positivo\*\*/);
  assert.match(md, /2\. \*\*ataque\*\*.*HTTP 200/);
  assert.match(md, /exchange-02\.req\.txt/);
  assert.match(md, /prova: `[^`]+result\.json`/);
  assert.match(md, /\*\*Demonstrated\.\*\* Impact basis `read`/);
  assert.match(md, /\*\*Not demonstrated\.\*\*/);
  assert.match(md, /does not own the referenced object/);
  assert.doesNotMatch(md, /Chain partners/);
});

test('sem result.json o documento declara a lacuna em vez de inventar o passo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{ verdict: 'proven', severity: 'P3', hypothesis: 'h', artifact: 'nao/existe/result.json', spec: 'a.json' }]);
  const md = fs.readFileSync(emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0].path, 'utf8');
  assert.match(md, /\*\*Gap:\*\* the proof directory has no step record/);
  assert.doesNotMatch(md, /\*\*controle positivo\*\*|\*\*ataque\*\*/);
});

test('cadeia vira cross-reference com id interno, nunca UUID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([
    { verdict: 'proven', severity: 'P3', hypothesis: 'elo 1', chain: 'cadeia-x', artifact: '1/r.json' },
    { verdict: 'proven', severity: 'P2', hypothesis: 'elo 2', chain: 'cadeia-x', artifact: '2/r.json' },
  ]);
  const md = fs.readFileSync(emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0].path, 'utf8');
  assert.match(md, /Chain partners \(not yet filed — internal references only\)/);
  assert.match(md, /1 of 2 primitives/);
  assert.doesNotMatch(md, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

test('documento emitido nao e reescrito enquanto a prova nao muda', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const cand = { verdict: 'proven', severity: 'P3', hypothesis: 'h', artifact: 'a/result.json', spec: 'a.json' };
  const st = stateCom([cand]);
  const first = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0];
  fs.appendFileSync(first.path, '\nEDITADO A MAO\n');
  const second = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0];
  assert.equal(second.fresh, false);
  assert.match(fs.readFileSync(second.path, 'utf8'), /EDITADO A MAO/);
});

test('prova nova reescreve o documento', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{ verdict: 'proven', severity: 'P3', hypothesis: 'h', artifact: 'a/1.json', spec: 'a.json' }]);
  emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' });
  st.targets.alvo.candidates[0].artifact = 'a/2.json';
  const again = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0];
  assert.equal(again.fresh, true);
  assert.match(fs.readFileSync(again.path, 'utf8'), /a\/2\.json/);
});

test('marcar submetido tira o item da fila pendente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{ verdict: 'proven', severity: 'P3', hypothesis: 'h', artifact: 'a/r.json' }]);
  const s = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0];
  markSubmitted(dir, s.id, { url: 'https://plataforma/report/1' });
  const again = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' })[0];
  assert.ok(again.submitted?.url);
  assert.match(renderSubmitIndex(dir, [again], { min: 'P3' }), /submetido/);
});

test('sem achado provado, nenhum documento', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const st = stateCom([{ verdict: 'inconclusive', severity: 'P1', hypothesis: 'talvez' }]);
  assert.deepEqual(emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' }), []);
});

// ------------------------------------------------------------------ deepen
test('catch-all e detectado pelo controle identico; JSON proprio e real', () => {
  const h = { status: 200, type: 'text/html', norm: 'a b', items: 0 };
  assert.equal(compareProbe(h, { status: 200, type: 'text/html', norm: 'a b' }).state, 'catch-all');
  assert.equal(compareProbe({ status: 200, type: 'application/json', norm: 'x', items: 3 }, { status: 404, norm: '' }).state, 'real');
  assert.equal(compareProbe({ status: 401 }, null).state, 'protegido');
  assert.equal(compareProbe({ status: 404 }, null).state, 'morto');
  assert.equal(compareProbe({ error: 'timeout' }, null).state, 'erro');
});

test('candidatos ignoram asset estatico e template', () => {
  const surface = {
    hosts: {
      'https://a.com/': { status: 200, url: 'https://a.com/', endpoints: ['/app.js', '/api/v1/pedidos', '/{id}/x', '/conta/fatura'] },
    },
  };
  assert.deepEqual(candidatesFromSurface(surface), ['https://a.com/api/v1/pedidos', 'https://a.com/conta/fatura']);
});

// ------------------------------------------------------------------ status
test('STATUS em foco abre com o objetivo, nao com contagem de alvos', () => {
  const st = stateCom([{ verdict: 'proven', severity: 'P3', hypothesis: 'BOLA', artifact: 'p/result.json' }]);
  st.cycle = 2;
  const md = renderStatus(st, [{ slug: 'alvo', platform: 'bugcrowd', scopeCapturedAt: fresh }], { min: 'P3' });
  assert.match(md, /engajamento `alvo`/);
  assert.match(md, /Objetivo: achado proven ≥ P3/);
  assert.match(md, /ABERTO/);
  assert.match(md, /BOLA/);
});

test('STATUS conta pendente pelo diretorio do engajamento, nao pelo focus.dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const st = stateCom([
    { verdict: 'proven', severity: 'P2', hypothesis: 'A1', artifact: 'a/r.json', spec: 'a.json' },
    { verdict: 'proven', severity: 'P3', hypothesis: 'A3', artifact: 'c/r.json', spec: 'c.json' },
  ]);
  st.focus = { slug: 'alvo', min: 'P3' };
  for (const c of st.targets.alvo.candidates) c.id = submitId(c);
  const subs = emitSubmits(dir, { focus: { slug: 'alvo' }, state: st, min: 'P3' });
  markSubmitted(dir, subs[0].id, { url: 'https://plataforma/report/1' });
  const md = renderStatus(st, [{ slug: 'alvo', platform: 'bugcrowd' }], { min: 'P3', dir });
  assert.match(md, /2 submit\(s\) emitido\(s\)/);
  assert.match(md, /1 pendente\(s\)/);
});
