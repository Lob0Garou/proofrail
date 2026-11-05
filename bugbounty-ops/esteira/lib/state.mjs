// Estado da esteira. Tudo persistido em disco: o processo pode morrer, a
// sessao pode fechar, e o trabalho continua de onde parou.
import fs from 'node:fs';
import path from 'node:path';

export const STATE_SCHEMA = 'esteira-state/v1';

export function newRunId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

export function emptyState(runId) {
  return {
    schema: STATE_SCHEMA,
    run_id: runId,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cycle: 0,
    stop_requested: false,
    counters: { validated: 0, rejected: 0, inconclusive: 0, standby: 0, error: 0, pending: 0 },
    targets: {},
  };
}

/** Grava sobre um temporario e renomeia — nunca deixa state.json truncado. */
export function saveState(file, state) {
  state.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const { _specsPendentes, ...persist } = state;
  fs.writeFileSync(tmp, JSON.stringify(persist, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Diario append-only: nunca reescreve, nunca perde evento. */
export function appendJournal(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

export function readJournal(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Conta os estados e devolve o resumo que alimenta STATUS.md e o relatorio. */
export function tally(state) {
  const c = { validated: 0, rejected: 0, inconclusive: 0, standby: 0, error: 0, pending: 0 };
  for (const t of Object.values(state.targets)) c[t.status] = (c[t.status] || 0) + 1;
  state.counters = c;
  return c;
}

export function requestStop(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${new Date().toISOString()}\n`);
}

export function stopRequested(file) {
  return fs.existsSync(file);
}

export function clearStop(file) {
  try { fs.rmSync(file); } catch { /* nao existia */ }
}
