#!/usr/bin/env node
// Supervisor da esteira — modo ENGAJAMENTO.
//
// Um alvo fixado por escopo anexado. O objetivo e' um PISO de severidade: a
// esteira so considera a missao cumprida quando existe achado PROVADO pelo juiz
// com tier >= piso. Ate' la ela cicla — varre, aprofunda, classifica, executa
// spec — e nunca para por conta propria. Para com STOP ou com --stop-at-p3.
//
// Nunca pergunta nada, nunca espera resposta: tudo vai para disco.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { newRunId, emptyState, saveState, loadState, appendJournal, tally, stopRequested } from './lib/state.mjs';
import { buildQueue } from './lib/queue.mjs';
import { classify, outcomeFromVerdict } from './lib/classify.mjs';
import { detectarImpasse, deveRegistrar, renderImpasse } from './lib/impasse.mjs';
import { sweepTarget } from './lib/sweep.mjs';
import { deepenTarget } from './lib/deepen.mjs';
import { writeStatus } from './lib/status.mjs';
import { DEFAULT_MIN, severityFromSpec, meetsMin, parseTier } from './lib/severity.mjs';
import {
  engagementDir, engagementFiles, readFocus, writeFocus, objectiveState,
} from './lib/engagement.mjs';
import { emitSubmits, writeSubmitIndex, submitId } from './lib/submits.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EST = path.join(ROOT, 'bugbounty-ops', 'esteira');
const KIT = path.resolve(process.env.ESTEIRA_REPLAYER_DIR || path.join(ROOT, 'replayer'));
const SURFACE_DIR = path.join(EST, 'surface');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ONCE = flag('--once');
const NO_SWEEP = flag('--no-sweep');
const NO_DEEPEN = flag('--no-deepen');
const VERBOSE = flag('--verbose');
const STOP_AT_P3 = flag('--stop-at-p3');
const INTERVAL_S = Number(opt('--interval', 60));
const MAX_MIN = Number(opt('--max-minutes', 0));       // 0 = sem limite
const MAX_ATTEMPTS = Number(opt('--max-attempts', 3));
const MIN_SEV = parseTier(opt('--min-severity', DEFAULT_MIN)) || DEFAULT_MIN;
const TARGET = opt('--target', null);

const slug = TARGET ? String(TARGET).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') : null;
const DIR = slug ? engagementDir(EST, slug) : null;
const FILES = slug ? engagementFiles(DIR) : {
  state: path.join(EST, 'state.json'),
  journal: path.join(EST, 'journal.jsonl'),
  stop: path.join(EST, 'STOP'),
  heartbeat: path.join(EST, 'HEARTBEAT'),
  status: path.join(EST, 'STATUS.md'),
  log: path.join(EST, 'esteira.log'),
  impasse: path.join(EST, 'IMPASSE.md'),
};

/** IMPASSE.md e' canal de acao, nao log: sobrescreve para nao virar historico. */
const writeImpasse = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch (e) {
    log(`  falha ao escrever IMPASSE.md: ${e.message}`);
  }
};

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  if (VERBOSE) console.log(line);
  fs.appendFileSync(FILES.log, line + '\n');
};

async function runEngine(specPath, scopeDir) {
  const spec = (() => { try { return JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch { return {}; } })();
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--import', path.join(import.meta.dirname, 'lib', 'replay-fetch-guard.mjs'), path.join(KIT, 'scripts', 'replay.mjs'), 'run', '--spec', specPath], {
      cwd: KIT, env: { ...process.env, ESTEIRA_CAPTURED_SCOPE: path.resolve(ROOT, scopeDir, 'scope.json') }, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    });
    const m = stdout.match(/veredito:\s*([a-z-]+)/i);
    const artifact = (stdout.match(/artefatos:\s*(.+)/i) || [, null])[1]?.trim() || null;
    const impact = (stdout.match(/impacto:\s*([a-z-]+)/i) || [, null])[1] || null;
    return { ok: true, verdict: m ? m[1].toLowerCase() : 'desconhecido', raw: stdout.slice(-4000), spec, artifact: artifact ? path.resolve(KIT, artifact) : null, impact };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const m = out.match(/veredito:\s*([a-z-]+)/i);
    const artifact = (out.match(/artefatos:\s*(.+)/i) || [, null])[1]?.trim() || null;
    return { ok: false, code: e.code ?? null, verdict: m ? m[1].toLowerCase() : null, raw: out.slice(-4000), error: e.message, spec, artifact: artifact ? path.resolve(KIT, artifact) : null };
  }
}

function mark(state, targetSlug, patch) {
  const prev = state.targets[targetSlug] || { attempts: 0 };
  state.targets[targetSlug] = {
    ...prev,
    ...patch,
    attempts: (prev.attempts || 0) + (patch.attempted ? 1 : 0),
    last_run: new Date().toISOString(),
  };
  delete state.targets[targetSlug].attempted;
}

/** Achado do juiz vira candidato — com severidade declarada pela spec, nunca inventada. */
function recordCandidate(state, targetSlug, r) {
  const t = state.targets[targetSlug] || (state.targets[targetSlug] = { attempts: 0 });
  t.candidates ||= [];
  const severity = severityFromSpec(r.spec);
  const cand = {
    at: new Date().toISOString(),
    severity,
    verdict: r.verdict,
    hypothesis: r.spec?.hypothesis || null,
    oracle: r.spec?.oracle || null,
    attribution: r.spec?.attribution?.claim || null,
    chain: r.spec?.chain || null,
    impact: r.impact || null,
    artifact: r.artifact,
    spec: r.spec?.__file || null,
  };
  cand.id = submitId(cand);
  const dup = t.candidates.findIndex((c) => c.spec && cand.spec && c.spec === cand.spec && c.verdict === cand.verdict && c.artifact === cand.artifact);
  if (dup >= 0) t.candidates[dup] = cand; else t.candidates.push(cand);
  return cand;
}

function rearmIfObjectiveLost(state, targetSlug) {
  // Alvo marcado validated nao e' alvo necessariamente encerrado: com piso, o
  // que fecha a missao e' o piso atingido. Enquanto a fila de spec nao esvazia,
  // o alvo continua elegivel para aprofundar.
  const t = state.targets[targetSlug];
  if (t && t.status === 'validated') t.status = 'pending';
}

async function cycle(state) {
  const all = buildQueue({
    campaignsDir: path.join(KIT, 'campaigns'),
    scopesDir: path.join(ROOT, 'bugbounty-ops', 'scopes'),
    scriptsDir: path.join(KIT, 'scripts'),
  });
  const queue = slug ? all.filter((t) => t.slug.toLowerCase() === slug) : all;
  if (slug && !queue.length) {
    log(`ALVO AUSENTE da fila: ${slug} (campanha ou escopo faltando)`);
    appendJournal(FILES.journal, { event: 'alvo-ausente', slug });
  }
  log(`ciclo ${state.cycle}: ${queue.length} alvo(s) na fila${slug ? ` (foco: ${slug})` : ''}`);

  for (const t of queue) {
    if (stopRequested(FILES.stop)) return;
    const cur = state.targets[t.slug];
    // `rejected` e' veredito do juiz: nao se re-testa o que ja foi julgado, a
    // menos que exista spec nova (mtime) — isso e' checado abaixo pelo `pendentes`.
    if (cur && cur.status === 'rejected' && !slug) continue;
    // `error` com attempts no teto NAO e' desistencia permanente: o erro pode
    // ser de spec (exit 4 = spec invalida), e a spec corrigida tem que poder
    // rodar. Sem esta ressalva, um alvo que errou 3 vezes ficava mudo para
    // sempre, mesmo com hipotese nova na fila.
    const specsDeEntrada = Array.isArray(t.specPaths) && t.specPaths.length ? t.specPaths : (t.specPath ? [t.specPath] : []);
    const temSpecNaoJulgada = specsDeEntrada.some((p) => {
      const st = (cur?.specs || {})[path.basename(p)]?.stamp;
      try { return st !== `${p}:${fs.statSync(p).mtimeMs}`; } catch { return false; }
    });
    if (cur && cur.status === 'error' && cur.attempts >= MAX_ATTEMPTS && !temSpecNaoJulgada) continue;

    // Cada spec e' uma hipotese independente: o alvo TEM varias, e cada uma roda
    // uma vez. Spec ja' julgada so' volta se o arquivo mudar (mtime) — nao a cada
    // ciclo gastando request com a mesma hipotese morta. Varredura e
    // aprofundamento seguem rodando: e' deles que sai a spec seguinte.
    const specs = Array.isArray(t.specPaths) && t.specPaths.length ? t.specPaths : (t.specPath ? [t.specPath] : []);
    const stampOf = (p) => { try { return `${p}:${fs.statSync(p).mtimeMs}`; } catch { return null; } };
    const julgadas = cur?.specs || {};
    const pendentes = specs.filter((p) => julgadas[path.basename(p)]?.stamp !== stampOf(p));
    if (slug) state._specsPendentes = pendentes.length;
    const specPath = pendentes[0] || null;
    const stamp = specPath ? stampOf(specPath) : null;
    const specVelha = specs.length > 0 && !specPath;
    if (specPath) t.specPath = specPath;

    // 1) superficie — um GET por ativo declarado. Tambem roda com alvo travado:
    //    e' a materia-prima da spec que falta.
    const surfAt = cur?.surface_at ? Date.parse(cur.surface_at) : null;
    const scopeAt = t.scopeCapturedAt ? Date.parse(t.scopeCapturedAt) : null;
    const scopeIsNewer = scopeAt != null && surfAt != null && scopeAt > surfAt;
    const scopeReady = t.scopeDir && Number.isFinite(scopeAt) && scopeAt <= Date.now() && scopeAt >= Date.now() - 7 * 86400000;
    const automationReady = Boolean(t.automationPolicy) && !/NAO VERIFICADA/i.test(String(t.automationPolicy));
    const needSweep = scopeReady && automationReady && !NO_SWEEP && (surfAt == null || Date.now() - surfAt > 24 * 3600 * 1000 || scopeIsNewer);

    if (needSweep) {
      if (scopeIsNewer) log(`  ${t.slug} escopo recapturado depois da varredura -> re-medindo`);
      try {
        const surf = await sweepTarget(t, { dir: SURFACE_DIR, log: VERBOSE ? log : () => {} });
        mark(state, t.slug, { surface_at: new Date().toISOString(), surface: surf.summary });
        appendJournal(FILES.journal, { event: 'surface', slug: t.slug, summary: surf.summary, reason: scopeIsNewer ? 'escopo-novo' : 'vencida' });
        saveState(FILES.state, state);
      } catch (e) {
        log(`  ${t.slug} varredura falhou: ${e.message}`);
      }
    }

    // 1-bis) aprofundamento: separa endpoint real de catch-all. Sem isso a fila
    //    de spec nasce de links de menu, que respondem 200 em qualquer coisa.
    if (scopeReady && automationReady && !NO_DEEPEN) {
      try {
        const d = await deepenTarget(t, { dir: SURFACE_DIR, log: VERBOSE ? log : () => {} });
        if (d) {
          mark(state, t.slug, { surface: { ...(state.targets[t.slug]?.surface || {}), ...d.summary } });
          if (!d.done) appendJournal(FILES.journal, { event: 'deepen', slug: t.slug, summary: d.summary });
          saveState(FILES.state, state);
        }
      } catch (e) {
        log(`  ${t.slug} aprofundamento falhou: ${e.message}`);
      }
    }

    // 2) classificacao do impedimento vinculante
    const cls = classify(t, { surface: state.targets[t.slug]?.surface });
    // Todo caminho que NAO executa spec e' impasse — inclusive `spec-velha`, que
    // antes so' registrava e dormia. Tratar so' o `else` deixava o caso mais
    // comum (a fila de specs esgotada) sem detector nenhum.
    const registrarImpasse = (c) => {
      // `anterior` PRECISA ser lido antes do mark: depois dele o stall do state
      // ja e' o novo, e comparar o novo consigo mesmo nunca registra nada.
      const anterior = state.targets[t.slug]?.stall || null;
      const stall = detectarImpasse(anterior, c);
      stall.desde ||= new Date().toISOString();
      mark(state, t.slug, { stall });
      if (deveRegistrar(anterior, stall)) {
        appendJournal(FILES.journal, {
          event: 'impasse', slug: t.slug, status: c.status, reason: c.reason,
          key: stall.key, ciclos: stall.ciclos, degrau: stall.degrau.id,
        });
        if (stall.ciclos > 1) log(`  IMPASSE ${t.slug}: ${stall.ciclos}x ${stall.key} -> ${stall.degrau.id}`);
      }
      if (FILES.impasse) writeImpasse(FILES.impasse, renderImpasse({ slug: t.slug, stall, cls: c, min: MIN_SEV }));
      return stall;
    };

    if (cls.status === 'pending' && specVelha) {
      mark(state, t.slug, { status: 'sem-spec', reason: 'spec-julgada', detail: `${specs.length} spec(s) julgada(s): só rodam de novo quando o arquivo mudar` });
      appendJournal(FILES.journal, { event: 'spec-velha', slug: t.slug, total: specs.length });
      log(`  ${t.slug} todas as ${specs.length} spec(s) já julgadas -> pulando execução`);
      registrarImpasse({ status: 'sem-spec', reason: 'spec-julgada' });
    } else if (cls.status === 'pending' && scopeReady && automationReady) {
      log(`  ${t.slug} pronto -> rodando ${path.basename(specPath)}`);
      const r = await runEngine(specPath, t.scopeDir);
      r.spec.__file = specPath;
      const out = r.verdict ? outcomeFromVerdict(r) : { status: 'error', reason: `engine exit ${r.code}` };
      const cand = recordCandidate(state, t.slug, r);
      const specsMap = { ...(state.targets[t.slug]?.specs || {}), [path.basename(specPath)]: { stamp, verdict: r.verdict, at: new Date().toISOString() } };
      // Spec executada = progresso: a contagem de impasse zera. Sem isso o alvo
      // carregaria 192 ciclos antigos de standby e escalaria direto para o
      // degrau maximo no primeiro bloqueio novo.
      mark(state, t.slug, { ...out, detail: r.error || null, attempted: true, verdict: r.verdict, spec_stamp: stamp, specs: specsMap, stall: null });
      appendJournal(FILES.journal, { event: 'engine', slug: t.slug, ...out, code: r.code ?? 0, verdict: r.verdict, severity: cand.severity, artifact: cand.artifact });
      rearmIfObjectiveLost(state, t.slug);

      const obj = objectiveState(state, MIN_SEV);
      if (r.verdict === 'proven' && FILES.submits) {
        // Achado provado sai do forno agora, sozinho e numerado — inclusive
        // abaixo do piso. O piso decide quando o ENGAJAMENTO fecha; o submit
        // não espera os outros achados.
        const focus = {
          ...(readFocus(DIR) || {}), slug: t.slug, platform: t.platform,
          capturedAt: t.scopeCapturedAt, rewards: t.rewards || null,
        };
        writeFocus(DIR, focus);
        const subs = emitSubmits(DIR, { focus, state, min: MIN_SEV, rewards: focus.rewards });
        const idx = writeSubmitIndex(DIR, subs, { min: MIN_SEV, rewards: focus.rewards });
        appendJournal(FILES.journal, { event: 'submit', slug: t.slug, id: cand.id, severity: cand.severity, fresh: subs.some((s) => s.id === cand.id && s.fresh) });
        log(`  SUBMIT emitido: ${cand.id} (${cand.severity || 'sem tier'}) -> ${idx}`);
      }
      if (obj.met) {
        state.objective_at ||= new Date().toISOString();
        state.status = 'objetivo-atingido';
        appendJournal(FILES.journal, { event: 'objetivo', slug: t.slug, min: MIN_SEV, best: obj.best?.severity, artifact: obj.best?.artifact });
        log(`  OBJETIVO ATINGIDO: ${obj.best?.severity} ${obj.best?.hypothesis || ''} -> ${FILES.submit}`);
      }
    } else {
      // NAO marca `attempted`: classificar nao e' tentar. Antes o classify
      // incrementava `attempts`, e um alvo em `error` com attempts >= MAX era
      // pulado para SEMPRE — 193 classifies viravam desistencia silenciosa.
      mark(state, t.slug, { ...cls });
      registrarImpasse(cls);
    }
    tally(state);
    saveState(FILES.state, state);
    writeStatus(FILES.status, state, queue, { min: MIN_SEV, surfaceDir: SURFACE_DIR, rewards: t?.rewards || null, dir: DIR });
  }

  tally(state);
  saveState(FILES.state, state);
  writeStatus(FILES.status, state, queue, { min: MIN_SEV, surfaceDir: SURFACE_DIR, rewards: queue[0]?.rewards || null, dir: DIR });
  fs.writeFileSync(FILES.heartbeat, `${new Date().toISOString()}\n`);
}

async function main() {
  fs.mkdirSync(DIR || EST, { recursive: true });
  let state = loadState(FILES.state);
  if (!state || flag('--fresh')) {
    state = emptyState(newRunId());
    log(`run iniciado: ${state.run_id}`);
    appendJournal(FILES.journal, { event: 'start', run_id: state.run_id, slug, min: MIN_SEV });
  } else {
    log(`run retomado: ${state.run_id} (ciclo ${state.cycle})`);
    appendJournal(FILES.journal, { event: 'resume', run_id: state.run_id, cycle: state.cycle });
  }
  if (slug) {
    state.focus = { slug, min: MIN_SEV, started_at: state.started_at, dir: DIR };
    const prev = readFocus(DIR) || {};
    writeFocus(DIR, { ...prev, slug, min: MIN_SEV });
  }
  state.stop_requested = false;
  saveState(FILES.state, state);

  const deadline = MAX_MIN > 0 ? Date.now() + MAX_MIN * 60_000 : Infinity;
  let idleStreak = 0;

  while (!stopRequested(FILES.stop) && Date.now() < deadline) {
    state.cycle += 1;
    saveState(FILES.state, state);
    try {
      await cycle(state);
    } catch (e) {
      log(`ciclo ${state.cycle} falhou: ${e.message}`);
      appendJournal(FILES.journal, { event: 'cycle-error', cycle: state.cycle, error: e.message });
    }
    if (ONCE) break;

    const obj = objectiveState(state, MIN_SEV);
    if (obj.met && STOP_AT_P3) break;

    const c = state.counters || {};
    const specsPendentes = state._specsPendentes ?? 0;
    const pendente = slug
      ? (obj.met && specsPendentes === 0 ? 0 : Math.max(specsPendentes, obj.met ? 0 : 1))
      : (c.pending || 0) + (c.error || 0);
    idleStreak = pendente > 0 ? 0 : idleStreak + 1;
    // ocioso nao sai: desacelera e segue vivo. So STOP (ou o piso) encerra.
    const wait = Math.min(INTERVAL_S * (1 + idleStreak), 900);
    log(`ciclo ${state.cycle} concluido (pendentes=${pendente}, objetivo=${obj.met ? 'ATINGIDO' : 'aberto'}) — dormindo ${wait}s`);
    for (let s = 0; s < wait; s += 5) {
      if (stopRequested(FILES.stop)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  state.stop_requested = stopRequested(FILES.stop);
  saveState(FILES.state, state);
  const met = objectiveState(state, MIN_SEV).met;
  const why = state.stop_requested ? 'stop' : ONCE ? 'once' : met ? 'objetivo' : 'deadline';
  appendJournal(FILES.journal, { event: why, run_id: state.run_id, cycle: state.cycle });
  log(`parado por: ${why}`);
  fs.writeFileSync(FILES.heartbeat, `parado ${new Date().toISOString()}\n`);
}

main().catch((e) => {
  log(`FATAL ${e.stack || e.message}`);
  appendJournal(FILES.journal, { event: 'fatal', error: e.message });
  process.exitCode = 1;
});

