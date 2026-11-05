// Aprofundamento de superficie: o que a varredura crua nao separa.
//
// A varredura responde "o host esta no ar". Ela nao responde a pergunta que
// importa: este caminho e' um endpoint REAL ou o catch-all do SPA/Framework que
// devolve 200 para qualquer coisa? Endpoint que responde 200 em `/path` E em
// `/path/__nc_xxxxxx` e' catch-all; so o diferencial separa.
//
// Leitura apenas: dois GET por endpoint, sem payload, sem autenticacao.
import fs from 'node:fs';
import { scopePolicy } from './scope-policy.mjs';
import { loadSurface, saveSurface } from './sweep.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SKIP = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|mp4|pdf)$/i;

/** Endpoints que merecem sonda: caminho de app, sem extensao de asset, sem template. */
export function candidatesFromSurface(surface, { limit = 40, target } = {}) {
  const allows = target ? scopePolicy(target) : () => true;
  const seen = new Set();
  const out = [];
  for (const h of Object.values(surface?.hosts || {})) {
    if (!h?.status || h.status >= 400 || !h.endpoints) continue;
    const base = h.finalUrl || h.url;
    let origin;
    try { origin = new URL(base).origin; } catch { continue; }
    for (const p of h.endpoints) {
      if (SKIP.test(p) || /\{|\}|\)|\[/.test(p)) continue;
      const url = origin + p;
      if (!allows(url) || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function get(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': UA, accept: '*/*' } });
    const body = await r.text();
    return { status: r.status, bytes: body.length, items: countItems(body), type: r.headers.get('content-type') || '', norm: normalize(body) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Corpo sem ruido: sem horario, sem nonce, sem whitespace — o que sobra e' forma. */
function normalize(body) {
  return String(body)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '')
    .replace(/[0-9a-f]{16,}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countItems(body) {
  const s = String(body).trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return 0;
  return (s.match(/"(?:id|uuid|slug|sku|key)"/g) || []).length;
}

/**
 * `real` quando o endpoint responde e o irmão-com-sufixo de controle NÃO devolve
 * a mesma coisa. `catch-all` quando os dois devolvem a mesma forma.
 * `json` e' sinal forte: catch-all raramente devolve JSON no caminho inventado.
 */
export function compareProbe(hit, control) {
  if (hit?.error || !hit?.status) return { state: 'erro', note: hit?.error || 'sem resposta' };
  if (hit.status >= 500) return { state: 'erro', note: `HTTP ${hit.status}` };
  if (hit.status === 401 || hit.status === 403) return { state: 'protegido', note: `HTTP ${hit.status} — existe e exige algo` };
  if (hit.status === 404) return { state: 'morto', note: 'HTTP 404' };
  const json = /json/i.test(hit.type);
  if (!control || control.error) return { state: 'duvidoso', note: 'sem controle válido' };
  if (control.status === hit.status && control.norm === hit.norm) return { state: 'catch-all', note: `identico ao controle (${hit.status})` };
  return { state: json ? 'real' : 'duvidoso', note: json ? `JSON proprio (${hit.status}) vs controle ${control.status}` : `difere do controle (${hit.status} vs ${control.status})` };
}

/**
 * Sonda os endpoints ainda nao classificados. Nada e' repetido entre ciclos, e o
 * teto por ciclo existe para nao transformar a madrugada em rajada.
 */
export async function deepenTarget(target, { dir, limit = 40, delayMs = 400, log = () => {} } = {}) {
  const surface = loadSurface(dir, target.slug);
  if (!surface) return null;
  surface.deepen ||= {};
  const allows = scopePolicy(target);
  for (const url of Object.keys(surface.deepen)) if (!allows(url)) delete surface.deepen[url];
  const todo = candidatesFromSurface(surface, { limit: limit * 3, target })
    .filter((u) => !surface.deepen[u])
    .slice(0, limit);
  if (!todo.length) return { done: true, summary: summarize(surface) };

  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const url = todo[i++];
      const nc = `__nc_${Math.random().toString(36).slice(2, 10)}`;
      const hit = await get(url);
      const controlUrl = new URL(url);
      controlUrl.pathname = controlUrl.pathname.replace(/\/?$/, '/') + nc;
      const ctl = hit.status && hit.status < 400 && allows(controlUrl.href) ? await get(controlUrl.href) : null;
      const cmp = compareProbe(hit, ctl);
      surface.deepen[url] = { at: new Date().toISOString(), ...cmp, hit: hit.status ?? null, items: hit.items ?? 0 };
      log(`  ${url} -> ${cmp.state} ${cmp.note}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, todo.length) }, worker));

  surface.deepen_at = new Date().toISOString();
  surface.summary = { ...(surface.summary || {}), ...summarize(surface) };
  saveSurface(dir, target.slug, surface);
  return { done: false, summary: surface.summary };
}

export function summarize(surface) {
  const all = Object.values(surface?.deepen || {});
  const n = (s) => all.filter((x) => x.state === s).length;
  return { deepenSondado: all.length, deepenReal: n('real'), deepenDuvidoso: n('duvidoso'), deepenProtegido: n('protegido'), deepenCatchAll: n('catch-all') };
}

/** Material para escrever spec: endpoints reais/protegidos, mais promissores primeiro. */
export function rankedEndpoints(surface, limit = 20) {
  const rank = { real: 0, protegido: 1, duvidoso: 2, 'catch-all': 3, morto: 4, erro: 5 };
  return Object.entries(surface?.deepen || {})
    .filter(([, v]) => v.state === 'real' || v.state === 'protegido')
    .sort((a, b) => (rank[a[1].state] - rank[b[1].state]) || (b[1].items - a[1].items))
    .slice(0, limit)
    .map(([url, v]) => ({ url, ...v }));
}

export function surfaceExists(dir, slug) {
  return fs.existsSync(`${dir}/${slug}.json`);
}
