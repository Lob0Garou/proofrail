// Varredura de superficie: um GET por host no escopo, sem autenticacao, sem
// payload. Nao "testa" nada — so responde o que esta' publicado. O que ela
// produz e' a materia-prima da spec que vai ser escrita depois.
import fs from 'node:fs';
import path from 'node:path';
import { scopePolicy } from './scope-policy.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Converte ativos do escopo em URLs de sonda. Importa respeitar o escopo:
 * `https://www.alvo.com/employers/ec/*` autoriza aquele caminho, nao a raiz —
 * entao a sonda e' o caminho declarado, sem inventar `/`.
 * `*.alvo.com` e' wildcard: precisa de descoberta de subdominio, nao vira sonda.
 */
export function probesFromAssets(assets = []) {
  const seen = new Map();
  const wildcards = [];
  const skipped = [];
  for (const a of assets) {
    const t = String(a.type || '').toLowerCase();
    if (t === 'mobile' || t === 'cidr' || t === 'ip' || t === 'google_play_app_id' || t === 'apple_store_app_id') continue;
    const raw = String(a.asset || '').trim();
    if (!raw) continue;
    if (raw.startsWith('*.')) { wildcards.push(raw); continue; }

    let probe = raw.replace(/\/\*+$/, '/').replace(/\*+/g, '');
    if (!/^\w+:\/\//.test(probe)) probe = `https://${probe}`;
    let u;
    try { u = new URL(probe); } catch { skipped.push(raw); continue; }
    if (!u.hostname || !u.hostname.includes('.') || u.hostname.includes('*')) { skipped.push(raw); continue; }
    if (!u.pathname) u.pathname = '/';
    if (!seen.has(u.href)) seen.set(u.href, { url: u.href, host: u.hostname, path: u.pathname, asset: raw });
  }
  return {
    probes: [...seen.values()].sort((x, y) => x.url.localeCompare(y.url)),
    wildcards: [...new Set(wildcards)].sort(),
    skipped,
  };
}

/** So os hosts unicos — para contar superficie sem duplicar. */
export function hostsFromAssets(assets = []) {
  return [...new Set(probesFromAssets(assets).probes.map((p) => p.host))].sort();
}

export function extractEndpoints(html, baseUrl, limit = 60) {
  const out = new Set();
  const s = String(html || '');
  for (const m of s.matchAll(/(?:src|href|action)\s*=\s*["']([^"']+)["']/gi)) {
    // o fragmento nao faz parte do recurso, mas excluir '#' da classe quebrava
    // o fechamento da aspa e o link inteiro era perdido
    const v = m[1].split('#')[0].trim();
    if (!v || v.startsWith('data:') || v.startsWith('mailto:') || v.startsWith('javascript:')) continue;
    try {
      const u = new URL(v, baseUrl);
      // so caminho do proprio alvo: link de CDN/terceiro viraria ruido no escopo
      if (u.origin !== new URL(baseUrl).origin) continue;
      out.add(u.pathname);
    } catch { /* ignora invalido */ }
    if (out.size >= limit) break;
  }
  for (const m of s.matchAll(/["'](\/(?:api|v[0-9]|graphql|rest|ajax)\/[A-Za-z0-9_\-./]{2,60})["']/g)) {
    out.add(m[1]);
    if (out.size >= limit) break;
  }
  return [...out].slice(0, limit).sort();
}

const pick = (h) => ({
  server: h.get('server') || null,
  poweredBy: h.get('x-powered-by') || null,
  contentType: h.get('content-type') || null,
  location: h.get('location') || null,
  poweredByVercel: h.get('x-vercel-id') ? 'vercel' : null,
  cfRay: h.get('cf-ray') ? 'cloudflare' : null,
});

export async function fingerprint(url, { timeoutMs = 12000, allows = (candidate) => candidate === url } = {}) {
  const t0 = Date.now();
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const rec = { url, host, scheme: null, finalUrl: null, status: null, headers: {}, title: null, bytes: 0, ms: 0, error: null, endpoints: [] };
  const tries = /^http:\/\//.test(url) ? [url] : [url, url.replace(/^https:\/\//, 'http://')];
  for (const target of tries.filter(allows)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let current = target;
      let r;
      for (let hop = 0; ; hop++) {
        r = await fetch(current, {
          redirect: 'manual', signal: ctl.signal,
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        });
        const location = r.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(r.status) || !location || hop >= 5) break;
        const next = new URL(location, current).href;
        if (!allows(next)) break;
        await r.body?.cancel();
        current = next;
      }
      const body = await r.text();
      rec.scheme = new URL(target).protocol.replace(':', '');
      rec.finalUrl = current;
      rec.status = r.status;
      rec.headers = pick(r.headers);
      rec.bytes = body.length;
      rec.title = (body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [, null])[1];
      if (rec.title) rec.title = rec.title.replace(/\s+/g, ' ').trim();
      rec.endpoints = extractEndpoints(body, current);
      rec.ms = Date.now() - t0;
      return rec;
    } catch (e) {
      rec.error = e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message;
      rec.ms = Date.now() - t0;
    } finally {
      clearTimeout(timer);
    }
  }
  return rec;
}

export function surfaceFile(dir, slug) {
  return path.join(dir, `${slug}.json`);
}

export function loadSurface(dir, slug) {
  try { return JSON.parse(fs.readFileSync(surfaceFile(dir, slug), 'utf8')); } catch { return null; }
}

export function saveSurface(dir, slug, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(surfaceFile(dir, slug), JSON.stringify(data, null, 2) + '\n');
}

/**
 * Varre os hosts do alvo e devolve o registro. Hosts ja varridos nascem
 * marcados como done: a noite seguinte nao repete o que ja foi feito.
 */
export async function sweepTarget(target, { dir, concurrency = 2, delayMs = 700, log = () => {} } = {}) {
  const prev = loadSurface(dir, target.slug) || { schema: 'surface/v1', slug: target.slug, hosts: {} };
  const { probes, wildcards } = probesFromAssets(target.assets);
  const allows = scopePolicy(target);
  for (const [url, record] of Object.entries(prev.hosts)) {
    if (!allows(url) || (record.finalUrl && !allows(record.finalUrl))) delete prev.hosts[url];
  }
  const key = (p) => p.url;
  const pending = probes.filter((p) => allows(p.url) && (!prev.hosts[key(p)] || prev.hosts[key(p)].status == null));
  log(`[${target.slug}] ${probes.length} sonda(s), ${pending.length} a varrer, ${wildcards.length} wildcard(s) fora do alcance`);

  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const rec = await fingerprint(p.url, { allows });
      rec.path = p.path;
      rec.asset = p.asset;
      prev.hosts[key(p)] = rec;
      log(`  ${p.url} -> ${rec.status ?? 'ERRO'} ${rec.title ? `"${rec.title.slice(0, 40)}"` : ''}${rec.error ? ` ${rec.error}` : ''}`);
      saveSurface(dir, target.slug, prev);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker));

  const all = Object.values(prev.hosts);
  prev.updated_at = new Date().toISOString();
  prev.wildcards = wildcards;
  prev.summary = {
    probes: probes.length,
    hosts: new Set(all.map((h) => h.host)).size,
    wildcards: wildcards.length,
    alive: all.filter((h) => h.status && h.status < 500).length,
    ok: all.filter((h) => h.status === 200).length,
    errored: all.filter((h) => h.error).length,
    endpoints: all.reduce((n, h) => n + (h.endpoints?.length || 0), 0),
  };
  saveSurface(dir, target.slug, prev);
  return prev;
}
