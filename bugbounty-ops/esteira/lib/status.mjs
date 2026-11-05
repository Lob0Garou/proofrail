// STATUS.md e' o canal de reporte. O agente escreve aqui e SEGUE — ninguem
// espera alguem ler. Em engajamento focado o arquivo abre com o OBJETIVO: qual
// piso de severidade falta e quais candidatos existem. E' isso que o operador lê
// ao acordar, e e' isso que decide se a noite terminou.
import fs from 'node:fs';
import path from 'node:path';
import { UNBLOCK } from './classify.mjs';
import { DEFAULT_MIN, sortCandidates, tierLabel } from './severity.mjs';
import { objectiveState } from './engagement.mjs';
import { loadSurface } from './sweep.mjs';
import { rankedEndpoints } from './deepen.mjs';
import { groupCandidates, readSubmitted } from './submits.mjs';

const ICON = { validated: '✔', rejected: '✖', inconclusive: '?', standby: '⏸', error: '!', pending: '…' };
const fmt = (ts) => (ts ? String(ts).replace('T', ' ').replace(/\..*/, '').replace('Z', 'Z') : '—');

function objectiveBlock(state, min, rewards, dir) {
  const L = [];
  const cands = sortCandidates(state.targets?.[state.focus?.slug]?.candidates || []);
  const { validos } = objectiveState(state, min);
  const grupos = groupCandidates(cands);
  const pendentes = grupos.filter((g) => !readSubmitted(dir || state.focus?.dir || '', g.key));
  L.push(`## Objetivo: achado proven ≥ ${min}`);
  L.push('');
  if (validos.length) {
    L.push(`**ATINGIDO** em ${fmt(validos[0].at)} — ${validos.length} candidato(s) no piso ou acima.`);
  } else {
    const provados = cands.filter((c) => c.verdict === 'proven');
    L.push(provados.length
      ? `**EM ABERTO** — ${provados.length} candidato(s) aguardando evidência ou abaixo do piso. Falta um achado ≥ ${min} para fechar o engajamento.`
      : `**EM ABERTO** — nenhum achado proven ainda. A esteira segue enquanto houver sonda, endpoint e spec.`);
  }
  if (grupos.length) {
    L.push('');
    L.push(`**${grupos.length} submit(s) emitido(s)** · ${pendentes.length} pendente(s) · um documento por achado em \`SUBMITS/\`.`);
  }
  L.push('');
  if (cands.length) {
    L.push('| severidade | veredito | hipótese | prova |');
    L.push('|---|---|---|---|');
    for (const c of cands.slice(0, 12)) {
      L.push(`| ${tierLabel(c.severity, rewards)} | ${c.verdict} | ${c.hypothesis || c.spec || '—'} | \`${c.artifact || '—'}\` |`);
    }
    L.push('');
  }
  if (L[L.length - 1] === '') L.pop();
  return L;
}

function signalEndpoints(surfaceDir, slug, limit = 15) {
  if (!surfaceDir || !slug) return [];
  const surface = loadSurface(surfaceDir, slug);
  if (!surface) return [];
  const ranked = rankedEndpoints(surface, limit);
  if (!ranked.length) return [];
  const L = ['', '## Endpoints com sinal (provável achado mora aqui)', ''];
  for (const e of ranked) L.push(`- \`${e.url}\` — ${e.state} · ${e.note}`);
  return L;
}

export function renderStatus(state, queue = [], opts = {}) {
  const min = opts.min || state.focus?.min || DEFAULT_MIN;
  const rewards = opts.rewards || state.focus?.rewards || null;
  const c = state.counters || {};
  const L = [];

  if (state.focus?.slug) {
    L.push(`# STATUS — engajamento \`${state.focus.slug}\``);
    L.push('');
    L.push(`- run: \`${state.run_id}\` · ciclo **${state.cycle}** · atualizado ${fmt(state.updated_at)} · iniciado ${fmt(state.started_at)}`);
    const q0 = queue.find((x) => x.slug === state.focus.slug);
    L.push(`- plataforma: ${q0?.platform || '—'} · escopo capturado: ${fmt(q0?.scopeCapturedAt)}`);
    L.push('');
    L.push(...objectiveBlock(state, min, rewards, opts.dir));
  } else {
    L.push('# STATUS — esteira autônoma');
    L.push('');
    L.push(`- run: \`${state.run_id}\` · ciclo **${state.cycle}** · atualizado ${fmt(state.updated_at)}`);
    L.push(`- iniciado: ${fmt(state.started_at)}`);
    L.push(`- **validados ${c.validated || 0}** · rejeitados ${c.rejected || 0} · inconclusivos ${c.inconclusive || 0} · **em standby ${c.standby || 0}** · erros ${c.error || 0}`);
  }

  const byPlat = {};
  for (const [slug, t] of Object.entries(state.targets)) {
    const p = queue.find((q) => q.slug === slug)?.platform || '—';
    byPlat[p] = byPlat[p] || { validated: 0, standby: 0, total: 0 };
    byPlat[p].total += 1;
    if (t.status === 'validated') byPlat[p].validated += 1;
    if (t.status === 'standby') byPlat[p].standby += 1;
  }
  if (!state.focus && Object.keys(byPlat).length) {
    L.push('');
    L.push('| plataforma | alvos | validados | standby |');
    L.push('|---|---|---|---|');
    for (const [p, v] of Object.entries(byPlat).sort()) L.push(`| ${p} | ${v.total} | ${v.validated} | ${v.standby} |`);
  }

  L.push('');
  L.push(state.focus ? '## Alvo' : '## Alvos');
  L.push('');
  L.push('| | plataforma | alvo | superfície | estado | motivo | destrava com |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [slug, t] of Object.entries(state.targets).sort((a, b) => a[0].localeCompare(b[0]))) {
    const q = queue.find((x) => x.slug === slug);
    const s = t.surface
      ? `${t.surface.alive}/${t.surface.probes} sondas · ${t.surface.deepenReal ?? 0} reais · ${t.surface.deepenCatchAll ?? 0} catch-all`
      : '—';
    L.push(`| ${ICON[t.status] || '·'} | ${q?.platform || '—'} | \`${slug}\` | ${s} | ${t.status} | ${t.reason || '—'}${t.detail ? ` (${t.detail})` : ''} | ${UNBLOCK[t.reason] || '—'} |`);
  }

  L.push(...signalEndpoints(opts.surfaceDir, state.focus?.slug));

  const standby = Object.entries(state.targets).filter(([, t]) => t.status === 'standby');
  if (standby.length) {
    L.push('');
    L.push(`## ${state.focus ? 'Impedimento atual' : 'Fila de destravamento (o que o operador precisa fazer)'}`);
    L.push('');
    const byReason = {};
    for (const [slug, t] of standby) (byReason[t.reason] = byReason[t.reason] || []).push(slug);
    for (const [reason, slugs] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
      L.push(`- **${reason}** (${slugs.length}): ${UNBLOCK[reason] || '—'}`);
      L.push(`  - ${slugs.map((s) => `\`${s}\``).join(' · ')}`);
    }
  }

  L.push('');
  L.push('> Gerado automaticamente. A esteira não espera leitura: o próximo ciclo reescreve este arquivo.');
  return L.join('\n') + '\n';
}

export function writeStatus(file, state, queue, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderStatus(state, queue, opts));
}
