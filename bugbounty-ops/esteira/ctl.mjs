#!/usr/bin/env node
// Controle da esteira — modo ENGAJAMENTO.
//
//   ctl.mjs ingest <arquivo|pasta>            anexa o escopo de UM alvo
//   ctl.mjs start --target <slug> [--min-severity P3] [--stop-at-p3]
//   ctl.mjs status | report | stop [--target <slug>]
//   ctl.mjs list                              engajamentos em disco
//
// `start` desacopla e volta na hora. A esteira segue ate' existir achado
// PROVADO com severidade >= piso ou ate' o operador mandar parar.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadState, readJournal, requestStop, clearStop, stopRequested, tally } from './lib/state.mjs';
import { buildQueue, orderHypotheses, hypothesisScore } from './lib/queue.mjs';
import { UNBLOCK } from './lib/classify.mjs';
import { renderStatus } from './lib/status.mjs';
import {
  engagementsDir, engagementDir, engagementFiles, listEngagements, resolveEngagement,
  slugFromToken, writeFocus, readFocus, inspectScope, objectiveState,
} from './lib/engagement.mjs';
import { DEFAULT_MIN, parseTier, sortCandidates, tierLabel } from './lib/severity.mjs';
import { loadSurface } from './lib/sweep.mjs';
import { rankedEndpoints } from './lib/deepen.mjs';
import { emitSubmits, writeSubmitIndex, renderSubmitIndex, groupCandidates, markSubmitted, submitPath } from './lib/submits.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EST = path.join(ROOT, 'bugbounty-ops', 'esteira');
const KIT = path.resolve(process.env.ESTEIRA_REPLAYER_DIR || path.join(ROOT, 'replayer'));
const SCOPES = path.join(ROOT, 'bugbounty-ops', 'scopes');
const SURFACE = path.join(EST, 'surface');
const RUN = path.join(EST, 'run.mjs');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TARGET = opt('--target', argv[1] && !argv[1].startsWith('--') && cmd !== 'ingest' ? argv[1] : null);

const FILES = (slug) => engagementFiles(engagementDir(EST, slug));

function queueNow() {
  return buildQueue({
    campaignsDir: path.join(KIT, 'campaigns'),
    scopesDir: SCOPES,
    scriptsDir: path.join(KIT, 'scripts'),
  });
}

function alive(files) {
  try {
    const pid = Number(fs.readFileSync(path.join(files.dir, 'esteira.pid'), 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

function needsTarget() {
  const r = resolveEngagement(EST, TARGET);
  if (r.error) { console.error(r.error); process.exit(2); }
  return { ...FILES(r.slug), slug: r.slug };
}

// ------------------------------------------------------------------ ingest
function doIngest() {
  const src = argv[1];
  if (!src || src.startsWith('--')) { console.error('uso: ctl.mjs ingest <scope.json|SCOPE.md|pasta>'); process.exit(2); }
  const abs = path.resolve(ROOT, src);
  const jsonPath = path.basename(abs).toLowerCase() === 'scope.md'
    ? path.join(path.dirname(abs), 'scope.json')
    : fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'scope.json') : abs;
  if (!fs.existsSync(jsonPath)) { console.error(`escopo sem scope.json: ${jsonPath}`); process.exit(2); }
  let scope;
  try { scope = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { console.error(`scope.json ilegivel: ${e.message}`); process.exit(2); }

  const v = inspectScope(scope);
  const slug = v.slug || slugFromToken(scope.slug);
  console.log(`alvo: ${slug || '(sem slug)'} · plataforma: ${scope.platform || '(ausente)'} · ativos: ${(scope.assets || []).length} · capturado: ${scope.capturedAt || '(sem data)'}`);
  const rewards = Object.entries(scope.rewards || {})
    .map(([k, v2]) => `${k}=${Array.isArray(v2) ? v2.filter(Boolean).join('–') || '—' : (v2 && typeof v2 === 'object' ? JSON.stringify(v2) : String(v2))}`)
    .join(' ');
  if (rewards) console.log(`faixas: ${rewards}`);
  if (!v.ok) {
    for (const p of v.problems) console.error(`  ✖ ${p}`);
    if (slug && /^[a-z]+$/i.test(scope.platform ?? '')) {
      const d = path.join(SCOPES, `${scope.platform}-${slug}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'scope.rejeitado.json'), JSON.stringify(scope, null, 2) + '\n');
      console.error(`  guardado para diagnostico em ${path.relative(ROOT, d)}/scope.rejeitado.json`);
    }
    process.exit(2);
  }

  const dest = path.join(SCOPES, `${scope.platform}-${slug}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(jsonPath, path.join(dest, 'scope.json'));
  const md = path.join(path.dirname(jsonPath), 'SCOPE.md');
  if (fs.existsSync(md)) fs.copyFileSync(md, path.join(dest, 'SCOPE.md'));
  writeFocus(engagementDir(EST, slug), {
    slug, platform: scope.platform, capturedAt: scope.capturedAt, scopeDir: path.relative(ROOT, dest), rewards: scope.rewards || null,
  });
  console.log(`anexado em ${path.relative(ROOT, dest)}/scope.json`);
}

// ------------------------------------------------------------------- start
function doStart() {
  const slug = slugFromToken(TARGET);
  if (!slug) { console.error('uso: ctl.mjs start --target <slug|pasta-de-escopo>'); process.exit(2); }
  const scopeFile = path.join(SCOPES, slug, 'scope.json');
  const found = fs.existsSync(scopeFile) ? scopeFile : null;
  const alt = fs.existsSync(SCOPES) && fs.readdirSync(SCOPES, { withFileTypes: true }).filter((e) => e.isDirectory() && slugFromToken(e.name) === slug)
    .map((e) => path.join(SCOPES, e.name, 'scope.json')).find((f) => fs.existsSync(f));
  if (!found && !alt) {
    console.error(`sem escopo anexado para \`${slug}\`. Anexe primeiro: node bugbounty-ops/esteira/ctl.mjs ingest <arquivo>`);
    process.exit(2);
  }
  const q = queueNow().find((t) => t.slug.toLowerCase() === slug || slugFromToken(t.slug) === slug);
  if (!q) {
    console.error(`\`${slug}\` tem escopo mas nao tem campanha em ${KIT}/campaigns/${slug}.json — sem campanha a esteira nao tem identidades nem politica de automacao.`);
    process.exit(3);
  }

  const files = FILES(slug);
  const pid = alive(files);
  if (pid) { console.log(`ja rodando (pid ${pid}) em ${slug}. Use: ctl.mjs status --target ${slug}`); return; }

  const min = parseTier(opt('--min-severity', DEFAULT_MIN)) || DEFAULT_MIN;
  clearStop(files.stop);
  fs.mkdirSync(files.dir, { recursive: true });
  const scope = JSON.parse(fs.readFileSync(found || alt, 'utf8'));
  const prev = readFocus(files.dir) || {};
  writeFocus(files.dir, { ...prev, slug, platform: scope.platform, capturedAt: scope.capturedAt, min, rewards: scope.rewards || null });

  const pass = ['--target', slug, '--min-severity', min];
  for (const f of ['--interval', '--max-minutes', '--max-attempts']) {
    const v = opt(f, null);
    if (v != null) pass.push(f, v);
  }
  for (const f of ['--stop-at-p3', '--fresh', '--no-sweep', '--no-deepen', '--verbose']) if (flag(f)) pass.push(f);

  const out = fs.openSync(files.log, 'a');
  const child = spawn(process.execPath, [RUN, ...pass], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.writeFileSync(path.join(files.dir, 'esteira.pid'), String(child.pid));
  const rel = path.relative(ROOT, files.dir);
  console.log(`esteira ligada em \`${slug}\` (pid ${child.pid}) — alvo fixado, piso ${min}${flag('--stop-at-p3') ? ', encerra no piso' : ', segue aprofundando depois do piso'}.`);
  console.log(`  STATUS:  ${rel}/STATUS.md`);
  console.log(`  SUBMITS: ${rel}/SUBMITS/INDEX.md (um documento por achado provado, na hora)`);
  console.log(`  parar:   node bugbounty-ops/esteira/ctl.mjs stop --target ${slug}`);
}

// -------------------------------------------------------------------- stop
function doStop() {
  const files = needsTarget();
  requestStop(files.stop);
  console.log(`STOP gravado em ${files.slug}. Para no proximo ponto seguro (nao no meio de um request).`);
  const pid = alive(files);
  if (pid) console.log(`pid ${pid} — o ciclo atual termina primeiro. Confira com: ctl.mjs status --target ${files.slug}`);
  else console.log('nenhum processo vivo: ja estava parada.');
}

// ------------------------------------------------------------------ status
function doList() {
  const all = listEngagements(EST);
  if (!all.length) { console.log('nenhum engajamento. Comece com: ctl.mjs ingest <escopo>'); return; }
  for (const slug of all) {
    const files = FILES(slug);
    const pid = alive(files);
    const st = loadState(files.state);
    const obj = objectiveState(st, readFocus(files.dir)?.min || DEFAULT_MIN);
    console.log(`${pid ? `VIVA(pid ${pid})` : 'parada'} · \`${slug}\` · objetivo ${obj.min}: ${obj.met ? 'ATINGIDO' : 'aberto'} · candidatos ${(st?.targets?.[slug]?.candidates || []).length}`);
  }
}

function doStatus() {
  if (!TARGET) return doList();
  const files = needsTarget();
  const st = loadState(files.state);
  const focus = readFocus(files.dir);
  const min = focus?.min || DEFAULT_MIN;
  const pid = alive(files);
  if (!st) { console.log(`sem estado para \`${files.slug}\`: a esteira nunca rodou. Use: ctl.mjs start --target ${files.slug}`); return; }
  tally(st);
  const obj = objectiveState(st, min);
  const t = st.targets?.[files.slug] || {};
  console.log(`engajamento \`${files.slug}\` (${focus?.platform || '—'}) | ${pid ? `VIVA (pid ${pid})` : 'parada'} | ciclo ${st.cycle}`);
  console.log(`objetivo proven ≥ ${min}: ${obj.met ? 'ATINGIDO' : 'ABERTO'}`);
  for (const f of obj.faltando) console.log(`  falta: ${f}`);
  const cands = sortCandidates(t.candidates || []);
  if (cands.length) {
    console.log('\ncandidatos:');
    for (const c of cands) console.log(`  ${c.severity || '—'} · ${c.verdict} · ${c.hypothesis || c.spec || ''} · ${c.artifact || ''}`);
  }
  console.log(`\nestado do alvo: ${t.status || '—'} · motivo: ${t.reason || '—'}${t.detail ? ` (${t.detail})` : ''}`);
  if (t.reason) console.log(`destrava: ${UNBLOCK[t.reason] || '—'}`);
  if (t.surface) console.log(`superficie: ${t.surface.alive}/${t.surface.probes} sondas · reais ${t.surface.deepenReal ?? 0} · protegidos ${t.surface.deepenProtegido ?? 0} · catch-all ${t.surface.deepenCatchAll ?? 0}`);
  console.log(`\nSTATUS.md: ${path.relative(ROOT, files.status)}`);
  const subs = groupCandidates(t.candidates || []);
  if (subs.length) console.log(`submits: ${subs.length} achado(s) provado(s) → ${path.relative(ROOT, files.submit)}`);
}

// ------------------------------------------------------------------ report
function focusOf(files) {
  // O foco em disco pode ter nascido so de `once`, sem plataforma/faixas. O
  // escopo anexado e' a fonte — sem ele, o SUBMIT sai sem tier e sem valor.
  const f = readFocus(files.dir) || {};
  const q = queueNow().find((t) => t.slug === files.slug);
  return {
    ...f, slug: files.slug,
    platform: f.platform || q?.platform || null,
    capturedAt: f.capturedAt || q?.scopeCapturedAt || null,
    rewards: f.rewards || q?.rewards || null,
  };
}

function doReport() {
  const files = needsTarget();
  const st = loadState(files.state);
  if (!st) { console.log('sem estado.'); return; }
  const focus = focusOf(files);
  const min = focus.min || DEFAULT_MIN;
  const rewards = focus.rewards || null;
  tally(st);
  const obj = objectiveState(st, min);
  const L = [];
  L.push(`# Relatório de engajamento — \`${files.slug}\``);
  L.push('');
  L.push(`Objetivo: achado **proven ≥ ${min}** · ${obj.met ? '**ATINGIDO**' : 'em aberto'}`);
  L.push(`Início ${st.started_at} · ciclo ${st.cycle} · atualizado ${st.updated_at}`);
  L.push('');
  L.push('## Candidatos');
  L.push('');
  const cands = sortCandidates(st.targets?.[files.slug]?.candidates || []);
  if (!cands.length) L.push('_nenhum achado registrado ainda_');
  for (const c of cands) {
    L.push(`- ${tierLabel(c.severity, rewards)} · veredito **${c.verdict}** · \`${c.hypothesis || c.spec || '—'}\``);
    if (c.artifact) L.push(`  - prova: \`${c.artifact}\``);
  }
  L.push('');
  const surface = loadSurface(SURFACE, files.slug);
  if (surface) {
    L.push('## Superfície medida');
    L.push('');
    L.push(`sondas ${surface.summary?.probes ?? 0} · vivas ${surface.summary?.alive ?? 0} · endpoints ${surface.summary?.endpoints ?? 0} · catch-all ${surface.summary?.deepenCatchAll ?? 0}`);
    L.push('');
    const ranked = rankedEndpoints(surface, 25);
    if (ranked.length) {
      L.push('### Endpoints com sinal');
      L.push('');
      for (const e of ranked) L.push(`- \`${e.url}\` — ${e.state} (${e.note})`);
      L.push('');
    }
  }
  const out = path.join(files.dir, `REPORT-${st.run_id}.md`);
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.log(`relatorio: ${path.relative(ROOT, out)}`);

  const subs = emitSubmits(files.dir, { focus, state: st, min, rewards });
  const idx = writeSubmitIndex(files.dir, subs, { min, rewards });
  const novos = subs.filter((s) => !s.submitted).length;
  console.log(`${subs.length} submit(s) emitido(s) (${novos} pendente(s)): ${path.relative(ROOT, idx)}`);
}

// ---------------------------------------------------------------- submits
function doSubmits() {
  const files = needsTarget();
  const st = loadState(files.state);
  const focus = focusOf(files);
  const min = focus.min || DEFAULT_MIN;
  const subs = emitSubmits(files.dir, { focus, state: st || {}, min, rewards: focus.rewards || null });
  const idx = writeSubmitIndex(files.dir, subs, { min, rewards: focus.rewards || null });
  if (!subs.length) { console.log('nenhum achado provado ainda: nada a despachar.'); return; }
  console.log(renderSubmitIndex(files.dir, subs, { min, rewards: focus.rewards || null }));
  console.log(`indice: ${path.relative(ROOT, idx)}`);
}

function doMark() {
  const files = needsTarget();
  const id = opt('--id', null);
  if (!id) { console.error('uso: ctl.mjs mark --target <slug> --id <id-do-submit> [--url <url>]'); process.exit(2); }
  const p = submitPath(files.dir, id);
  if (!fs.existsSync(p)) { console.error(`submit inexistente: ${path.relative(ROOT, p)}`); process.exit(2); }
  markSubmitted(files.dir, id, { url: opt('--url', null) });
  console.log(`marcado como submetido: ${path.basename(p)}`);
}

// ---------------------------------------------------------------- findings
function doFindings() {
  const files = needsTarget();
  const q = queueNow().find((t) => t.slug === files.slug);
  if (!q) { console.error(`sem campanha para \`${files.slug}\``); process.exit(3); }
  const surface = loadSurface(SURFACE, files.slug);
  const eps = surface ? rankedEndpoints(surface, 25) : [];
  const instructions = (q.assets || []).map((a) => a.instruction || '').join(' ');
  const ctx = { instructions, money: /\$\d/.test(JSON.stringify(q.rewards || {})) };
  const open = orderHypotheses(q.hypotheses || [], ctx)
    .filter((h) => /open|-untested|aberta/i.test(String(h.state || '')));
  const L = [];
  L.push(`# FINDINGS — \`${files.slug}\``);
  L.push('');
  L.push('> Pauta de caça da tripulação, ordenada por pontuação (classe + foco do programa + dinheiro). A primeira linha é a próxima spec, não a que está na mão.');
  L.push('> Hipótese sem endpoint com sinal não vira spec — vira pendência de medição.');
  L.push('');
  L.push('## Hipóteses abertas');
  L.push('');
  for (const h of open) L.push(`- **${hypothesisScore(h, ctx)}** · **${h.id}** — ${h.statement}${h.next_allowed_action ? ` _(destrava: ${h.next_allowed_action})_` : ''}`);
  if (!open.length) L.push('_nenhuma hipótese aberta na campanha: escrever novas_');
  L.push('');
  L.push('## Endpoints com sinal');
  L.push('');
  for (const e of eps) L.push(`- \`${e.url}\` — ${e.state} · ${e.note}`);
  if (!eps.length) L.push('_superfície ainda sem endpoint classificado: rodar a esteira sem `--no-deepen`_');
  L.push('');
  L.push('## Foco declarado pelo programa por ativo');
  L.push('');
  for (const a of q.assets || []) if (a.instruction) L.push(`- \`${a.asset}\` — ${a.instruction}`);
  const out = files.findings;
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(out, L.join('\n') + '\n');
  console.log(`pauta: ${path.relative(ROOT, out)} (${open.length} hipótese(s) aberta(s), ${eps.length} endpoint(s) com sinal)`);
}

function doOnce() {
  const slug = slugFromToken(TARGET);
  const pass = ['--once'];
  if (slug) pass.push('--target', slug, '--min-severity', parseTier(opt('--min-severity', DEFAULT_MIN)) || DEFAULT_MIN);
  for (const f of ['--no-sweep', '--no-deepen', '--fresh', '--verbose']) if (flag(f)) pass.push(f);
  const child = spawn(process.execPath, [RUN, ...pass], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code; });
}

const actions = { ingest: doIngest, start: doStart, stop: doStop, status: doStatus, list: doList, report: doReport, findings: doFindings, submits: doSubmits, mark: doMark, once: doOnce };
const fn = actions[cmd];
if (!fn) {
  console.error('uso: ctl.mjs <ingest|start|status|list|report|findings|submits|mark|stop|once> [--target <slug>] [--min-severity P3] [--stop-at-p3] [--interval 60] [--max-minutes N] [--fresh] [--no-sweep] [--no-deepen] [--verbose]');
  process.exit(1);
}
fn();


