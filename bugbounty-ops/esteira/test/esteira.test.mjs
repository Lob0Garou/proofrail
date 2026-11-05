import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classify, outcomeFromVerdict, webAssets, UNBLOCK } from '../lib/classify.mjs';
import { hostsFromAssets, probesFromAssets, extractEndpoints, sweepTarget } from '../lib/sweep.mjs';
import { renderStatus } from '../lib/status.mjs';
import { emptyState, saveState, loadState, appendJournal, readJournal, tally } from '../lib/state.mjs';
import { buildQueue, orderHypotheses, hypothesisScore } from '../lib/queue.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const fresh = '2026-11-05T02:00:00Z';

const base = (over = {}) => ({
  slug: 'alvo',
  assets: [{ asset: 'www.alvo.com', type: 'domain', eligible: true }],
  accounts: [],
  specPath: null,
  scopeCapturedAt: fresh,
  knownIssues: null,
  automationPolicy: 'leitura apenas, ≤5 rps',
  specNeedsIdentities: 2,
  ...over,
});

// ---------------------------------------------------------------- classify
test('sem ativo nenhum: standby escopo-vazio', () => {
  const r = classify(base({ assets: [] }), { now: NOW });
  assert.equal(r.status, 'standby');
  assert.equal(r.reason, 'escopo-vazio');
  assert.equal(r.unblock, UNBLOCK['escopo-vazio']);
});

test('so ativo movel ou CIDR: standby sem-superficie-web', () => {
  const r = classify(base({
    assets: [
      { asset: 'App Android', type: 'mobile' },
      { asset: '10.0.0.0/8', type: 'cidr' },
      { asset: 'com.x.app', type: 'google_play_app_id' },
    ],
  }), { now: NOW });
  assert.equal(r.reason, 'sem-superficie-web');
});

test('escopo com mais de 7 dias: standby escopo-vencido', () => {
  const r = classify(base({ scopeCapturedAt: '2026-10-01T00:00:00Z' }), { now: NOW });
  assert.equal(r.reason, 'escopo-vencido');
});

test('captura ausente nao vira memoria: escopo-vencido', () => {
  const r = classify(base({ scopeCapturedAt: null }), { now: NOW });
  assert.equal(r.reason, 'escopo-vencido');
});

test('sem spec: standby sem-spec e o detalhe conta os hosts varridos', () => {
  const r = classify(base({ specPath: null, accounts: [] }), { now: NOW });
  assert.equal(r.reason, 'sem-spec');
  assert.match(r.detail, /1 host/);
});

test('spec existe mas falta conta: sem-contas vence sem-spec', () => {
  const r = classify(base({ specPath: '/x/replay-alvo.json', accounts: [] }), { now: NOW });
  assert.equal(r.reason, 'sem-contas');
  assert.match(r.detail, /2 identidades, campanha tem 0/);
});

test('uma conta so nao basta para BOLA', () => {
  const r = classify(base({ specPath: '/s.json', accounts: [{ id: 'A' }] }), { now: NOW });
  assert.equal(r.reason, 'sem-contas');
});

test('duas contas mas known issues travado em 401: base-duplicata-incompleta', () => {
  const r = classify(base({
    specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }],
    knownIssues: { locked: true, status: 401 },
  }), { now: NOW });
  assert.equal(r.reason, 'base-duplicata-incompleta');
  assert.match(r.detail, /401/);
});

test('known issues nunca capturado tambem trava', () => {
  const r = classify(base({ specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }], knownIssues: null }), { now: NOW });
  assert.equal(r.reason, 'base-duplicata-incompleta');
});

// O gate de known issues so faz sentido onde a plataforma expoe o dado. Bugcrowd
// expoe; HackerOne, Intigriti e YesWeHack nao. Exigir deles travava o alvo para
// sempre e a esteira rodava sem executar spec nenhum.
for (const plat of ['hackerone', 'intigriti', 'yeswehack']) {
  test(`${plat} sem known issues nao trava: a plataforma nao expoe o dado`, () => {
    const r = classify(base({
      platform: plat, specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }],
      knownIssues: null, automationPolicy: 'leitura apenas, <=5 rps',
    }), { now: NOW });
    assert.equal(r.reason, 'pronto');
  });
}

test('bugcrowd sem known issues continua travando (o dado existe e falta)', () => {
  const r = classify(base({
    platform: 'bugcrowd', specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }],
    knownIssues: null,
  }), { now: NOW });
  assert.equal(r.reason, 'base-duplicata-incompleta');
});

test('plataforma ausente assume o gate: conservador, nao permissivo', () => {
  const r = classify(base({ specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }], knownIssues: null }), { now: NOW });
  assert.equal(r.reason, 'base-duplicata-incompleta');
});

test('politica de automacao nao verificada trava antes de disparar request', () => {
  const r = classify(base({
    specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }],
    knownIssues: { unique: 4, total: 9 },
    automationPolicy: 'NAO VERIFICADA na captura de 2026-11-05',
  }), { now: NOW });
  assert.equal(r.reason, 'regra-de-automacao-ausente');
});

test('tudo preenchido: pending (a esteira pode executar)', () => {
  const r = classify(base({
    specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }],
    knownIssues: { unique: 4, total: 9 },
  }), { now: NOW });
  assert.equal(r.status, 'pending');
  assert.equal(r.unblock, null);
});

test('precedencia: o motivo reportado e o impedimento que trava de fato', () => {
  // sem spec E sem contas E sem known issues -> o primeiro e' sem-spec
  const r = classify(base({ specPath: null, accounts: [], knownIssues: null }), { now: NOW });
  assert.equal(r.reason, 'sem-spec');
});

test('todo motivo de standby tem acao de destravamento declarada', () => {
  const reasons = new Set([
    classify(base({ assets: [] }), { now: NOW }).reason,
    classify(base({ assets: [{ asset: 'x', type: 'cidr' }] }), { now: NOW }).reason,
    classify(base({ scopeCapturedAt: null }), { now: NOW }).reason,
    classify(base({ specPath: null }), { now: NOW }).reason,
    classify(base({ specPath: '/s.json' }), { now: NOW }).reason,
    classify(base({ specPath: '/s.json', accounts: [{ id: 'A' }, { id: 'B' }] }), { now: NOW }).reason,
  ]);
  for (const r of reasons) assert.ok(UNBLOCK[r], `sem unblock para ${r}`);
});

// ---------------------------------------------------------------- veredito
test('not-vulnerable e veredito do juiz, nao erro do motor', () => {
  const r = outcomeFromVerdict({ verdict: 'not-vulnerable' });
  assert.equal(r.status, 'rejected');
  assert.match(r.reason, /not-vulnerable/);
});

test('so o judge promove: proven vira validated', () => {
  assert.equal(outcomeFromVerdict({ verdict: 'proven' }).status, 'validated');
  assert.equal(outcomeFromVerdict({ verdict: 'rejected' }).status, 'rejected');
  assert.equal(outcomeFromVerdict({ verdict: 'inconclusive' }).status, 'inconclusive');
  assert.equal(outcomeFromVerdict({ verdict: '' }).status, 'error');
  assert.equal(outcomeFromVerdict({}).status, 'error');
});

// ---------------------------------------------------------------- superficie
test('probesFromAssets respeita o caminho declarado em vez de inventar a raiz', () => {
  const { probes, wildcards } = probesFromAssets([
    { asset: 'https://www.alvo.com/employers/ec/*', type: 'api' },
    { asset: 'gitlab.com', type: 'URL' },
    { asset: '*.alvo.com', type: 'WILDCARD' },
    { asset: '10.0.0.0/8', type: 'cidr' },
    { asset: '1.2.3.4', type: 'ip' },
    { asset: 'App iOS', type: 'mobile' },
  ]);
  const urls = probes.map((p) => p.url);
  assert.deepEqual(urls, ['https://gitlab.com/', 'https://www.alvo.com/employers/ec/']);
  assert.deepEqual(wildcards, ['*.alvo.com']);
  assert.equal(probes.find((p) => p.host === 'www.alvo.com').path, '/employers/ec/');
});

test('hostsFromAssets deduplica por host e ignora o que nao e host', () => {
  const hosts = hostsFromAssets([
    { asset: 'https://www.alvo.com/a/*', type: 'api' },
    { asset: 'https://www.alvo.com/b/*', type: 'api' },
    { asset: 'https://api.alvo.com/', type: 'url' },
    { asset: '*.alvo.com', type: 'wildcard' },
    { asset: '1.2.3.4', type: 'ip' },
  ]);
  assert.deepEqual(hosts, ['api.alvo.com', 'www.alvo.com']);
});

test('extractEndpoints: pega src/href e caminhos de API, relativiza e deduplica', () => {
  const html = `<script src="/static/app.js"></script>
    <a href="/conta/fatura?x=1#frag">f</a>
    <form action="/login"></form>
    <script>fetch("/api/v1/orders")</script>
    <a href="https://outro.com/x">externo</a>`;
  const eps = extractEndpoints(html, 'https://www.alvo.com/');
  assert.ok(eps.includes('/static/app.js'));
  assert.ok(eps.includes('/conta/fatura'));
  assert.ok(eps.includes('/login'));
  assert.ok(eps.includes('/api/v1/orders'));
  assert.ok(!eps.includes('/x'));
});

test('webAssets separa o que e HTTP do que nao e', () => {
  assert.equal(webAssets([
    { type: 'domain' }, { type: 'wildcard' }, { type: 'mobile' }, { type: 'cidr' },
  ]).length, 2);
});

// ---------------------------------------------------------------- estado
test('estado sobrevive a round-trip e nao deixa arquivo truncado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-'));
  const f = path.join(dir, 'state.json');
  const st = emptyState('run-1');
  st.targets = { a: { status: 'standby', reason: 'sem-spec' } };
  saveState(f, st);
  const back = loadState(f);
  assert.equal(back.run_id, 'run-1');
  assert.equal(back.targets.a.reason, 'sem-spec');
  assert.ok(!fs.existsSync(`${f}.tmp`));
  assert.ok(fs.existsSync(`${f}.tmp`) === false);
});

test('journal e append-only e nao perde evento', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-'));
  const f = path.join(dir, 'journal.jsonl');
  appendJournal(f, { event: 'start', run_id: 'r' });
  appendJournal(f, { event: 'classify', slug: 'a', status: 'standby' });
  const ev = readJournal(f);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].event, 'start');
  assert.ok(ev[0].ts);
  assert.equal(ev[1].slug, 'a');
});

test('tally conta cada status', () => {
  const st = emptyState('r');
  st.targets = {
    a: { status: 'validated' }, b: { status: 'standby' }, c: { status: 'standby' }, d: { status: 'error' },
  };
  const c = tally(st);
  assert.equal(c.validated, 1);
  assert.equal(c.standby, 2);
  assert.equal(c.error, 1);
  assert.equal(c.pending, 0);
});

// ---------------------------------------------------------------- status
test('STATUS.md mostra contadores, alvos e a fila de destravamento', () => {
  const st = emptyState('run-x');
  st.cycle = 3;
  st.targets = {
    alvo1: { status: 'standby', reason: 'sem-contas', detail: 'spec exige 2, tem 0', surface: { alive: 2, probes: 3, endpoints: 5 } },
    alvo2: { status: 'validated', reason: 'engine:proven' },
  };
  tally(st);
  const md = renderStatus(st, [{ slug: 'alvo1', platform: 'bugcrowd' }, { slug: 'alvo2', platform: 'hackerone' }]);
  assert.match(md, /validados 1/);
  assert.match(md, /em standby 1/);
  assert.match(md, /alvo1/);
  assert.match(md, /2\/3 sondas/);
  assert.match(md, /sem-contas/);
  assert.match(md, /Criar as identidades A e B/);
  assert.match(md, /não espera leitura/);
});

// ---------------------------------------------------------------- fila
test('buildQueue le campanhas reais e ignora template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-q-'));
  const camp = path.join(dir, 'campaigns');
  const scopes = path.join(dir, 'scopes');
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(camp, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(camp, '_TEMPLATE.json'), JSON.stringify({ program: 'PREENCHER-slug', platform: 'bugcrowd' }));
  fs.writeFileSync(path.join(camp, 'real.json'), JSON.stringify({ program: 'real', platform: 'bugcrowd', assets: [{ asset: 'a.com' }] }));
  const q = buildQueue({ campaignsDir: camp, scopesDir: scopes, scriptsDir: scripts });
  assert.equal(q.length, 1);
  assert.equal(q[0].slug, 'real');
  assert.equal(q[0].specPath, null);
});

test('pauta ordena por classe, nao por id alfabetico', () => {
  const hs = [
    { id: 'A1-xss', statement: 'xss refletido no campo de busca', state: 'open-untested' },
    { id: 'Z9-rce', statement: 'comando do SO via parametro de template', state: 'open-untested' },
    { id: 'M3-idor', statement: 'B le objeto de A', state: 'open-untested' },
    { id: 'B2-xss', statement: 'ja testado', state: 'dead' },
  ];
  const ordered = orderHypotheses(hs);
  assert.deepEqual(ordered.map((h) => h.id), ['Z9-rce', 'M3-idor', 'A1-xss', 'B2-xss']);
  // foco declarado pelo programa na classe sobe a hipotese sem mudar a base
  const comFoco = hypothesisScore(hs[2], { instructions: 'Broken Access Control, IDOR' });
  assert.equal(comFoco, hypothesisScore(hs[2]) + 6);
  // dinheiro no statement soma, known issue da mesma classe soma
  assert.equal(hypothesisScore(hs[2], { money: true }), hypothesisScore(hs[2]));
  assert.ok(hypothesisScore({ id: 'P1', statement: 'manipula preco no checkout', state: 'open' }, { money: true })
    > hypothesisScore({ id: 'P1', statement: 'manipula preco no checkout', state: 'open' }));
});

test('sweepTarget nao repete sonda ja varrida', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-s-'));
  const slug = 'x';
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({
    schema: 'surface/v1', slug, hosts: { 'https://ja.com/': { url: 'https://ja.com/', host: 'ja.com', status: 200 } },
  }));
  // alvo sem sonda nova: nao deve disparar rede nenhuma
  const out = await sweepTarget({ slug, assets: [{ asset: 'ja.com', type: 'domain' }] }, { dir, delayMs: 0 });
  assert.equal(out.summary.probes, 1);
  assert.equal(out.hosts['https://ja.com/'].status, 200);
});
