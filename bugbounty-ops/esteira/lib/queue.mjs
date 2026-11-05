// Monta a fila de trabalho a partir do que existe em disco: campanhas do kit +
// escopos capturados + specs do replay. Nada e' inventado aqui — alvo sem
// campanha nao entra, alvo sem spec entra como standby.
import fs from 'node:fs';
import path from 'node:path';
import { tierRank } from './severity.mjs';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Ordem de escrita de spec: hipotese aberta primeiro, e entre as abertas a de
// maior pontuacao. Sem o numero a tripulacao escolhe a hipotese que esta na mao,
// e a que esta na mao e quase sempre a de menor impacto. A base por classe e a
// ordem em que o programa paga, nao a ordem alfabetica do banco.
const OPEN = /open|-untested|aberta/i;

const CLASS_BASE = [
  [/rce|remote-code|command-injection/, 10],
  [/sqli|sql-injection|auth-bypass|ato|account-takeover|ssti|deser/, 9],
  [/idor|bola|bac|access-control|privesc|privilege|ssrf|jwt|saml|business-logic|logica/, 8],
  [/secret|sde|disclosure|exposure|info-disc/, 6],
  [/xss|open-redirect|cors/, 3],
];

/** Classe inferida do id e do statement. Campo `class` explicito vence. */
export function hypothesisClass(h) {
  if (h?.class) return String(h.class);
  const blob = `${h?.id || ''} ${h?.statement || ''}`.toLowerCase();
  for (const [re] of CLASS_BASE) if (re.test(blob)) return re.source.split('|')[0];
  return null;
}

export function hypothesisScore(h, { instructions = '', money = false, knownClasses = [] } = {}) {
  const blob = `${h?.id || ''} ${h?.statement || ''} ${h?.class || ''}`.toLowerCase();
  let score = 4;
  for (const [re, base] of CLASS_BASE) if (re.test(blob)) { score = base; break; }
  const instr = String(instructions || '').toLowerCase();
  if (instr && CLASS_BASE.some(([re]) => re.test(blob) && re.test(instr))) score += 6;
  if (money && /billing|payment|checkout|invoice|subscription|order|fatura|pagamento/.test(blob)) score += 4;
  if (knownClasses.some((k) => k && blob.includes(String(k).toLowerCase()))) score += 5;
  return score;
}

export function orderHypotheses(list = [], ctx = {}) {
  return [...list].sort((a, b) => {
    const oa = OPEN.test(String(a.state || '')) ? 0 : 1;
    const ob = OPEN.test(String(b.state || '')) ? 0 : 1;
    return oa - ob
      || hypothesisScore(b, ctx) - hypothesisScore(a, ctx)
      || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

export function indexScopes(scopesDir) {
  const bySlug = new Map();
  if (!fs.existsSync(scopesDir)) return bySlug;
  for (const d of fs.readdirSync(scopesDir)) {
    const f = path.join(scopesDir, d, 'scope.json');
    if (!fs.existsSync(f)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      bySlug.set(norm(s.slug), { ...s, _scopeFile: f, _dir: path.join(scopesDir, d) });
      bySlug.set(norm(`${s.platform}-${s.slug}`), { ...s, _scopeFile: f, _dir: path.join(scopesDir, d) });
    } catch { /* escopo corrompido nao derruba a fila */ }
  }
  return bySlug;
}

export function findSpec(scriptsDir, slug, campaign) {
  if (campaign?.spec_path) {
    const p = path.isAbsolute(campaign.spec_path) ? campaign.spec_path : path.join(scriptsDir, '..', campaign.spec_path);
    if (fs.existsSync(p)) return p;
  }
  const guess = path.join(scriptsDir, `replay-${norm(slug)}.json`);
  return fs.existsSync(guess) ? guess : null;
}

/**
 * Todas as specs do alvo: `replay-<slug>.json` e as irma's `replay-<slug>.<n>.json`.
 * Um alvo tem varios achados independentes — uma spec por hipotese, nao uma spec
 * por alvo. Ordem: mais grave primeiro (o juiz paga na frente), depois nome.
 */
export function findSpecs(scriptsDir, slug, campaign) {
  const base = norm(slug);
  let files = [];
  try { files = fs.readdirSync(scriptsDir); } catch { files = []; }
  const mine = files
    .filter((f) => /^replay-.*\.json$/i.test(f))
    .filter((f) => {
      const stem = f.replace(/^replay-/i, '').replace(/\.json$/i, '');
      return stem === base || stem.startsWith(`${base}.`) || stem.startsWith(`${base}-`);
    })
    .map((f) => path.join(scriptsDir, f));
  const ordered = mine
    .map((p) => {
      let sev = null;
      try { sev = JSON.parse(fs.readFileSync(p, 'utf8')).severity || null; } catch { sev = null; }
      return { p, sev };
    })
    .sort((a, b) => tierRank(a.sev) - tierRank(b.sev) || a.p.localeCompare(b.p))
    .map((x) => x.p);
  const single = findSpec(scriptsDir, slug, campaign);
  if (single && !ordered.includes(single)) ordered.unshift(single);
  return ordered;
}

// PLATAFORMAS suportadas. Adicionar plataforma = adicionar o nome aqui; se o
// adapter do scope-first existir, a campanha ja nasce com esse `platform` e a
// fila passa a le-la. YesWeHack ficou de fora por esquecimento e os 4 escopos
// capturados nunca entraram na esteira — o laco rodava com 13 alvos em vez de 17.
export const PLATFORMS = ['bugcrowd', 'hackerone', 'intigriti', 'yeswehack'];

export function buildQueue({ campaignsDir, scopesDir, scriptsDir, skip = [], platforms = PLATFORMS }) {
  const scopes = indexScopes(scopesDir);
  const skipSet = new Set(skip.map(norm));
  const platSet = new Set(platforms);
  const out = [];
  if (!fs.existsSync(campaignsDir)) return out;

  for (const f of fs.readdirSync(campaignsDir)) {
    if (!f.endsWith('.json')) continue;
    const campaign = (() => { try { return JSON.parse(fs.readFileSync(path.join(campaignsDir, f), 'utf8')); } catch { return null; } })();
    if (!campaign || typeof campaign !== 'object') continue;
    // ignora template e arquivos que nao sao campanha de programa
    if (!campaign.program || /^preencher/i.test(campaign.program)) continue;
    if (!campaign.platform || !platSet.has(campaign.platform)) continue;
    if (skipSet.has(norm(campaign.program))) continue;

    const slug = campaign.program;
    const scope = scopes.get(norm(slug)) || scopes.get(norm(`${campaign.platform}-${slug}`)) || null;
    const specPaths = findSpecs(scriptsDir, slug, campaign);
    const specPath = specPaths[0] || null;

    out.push({
      slug,
      platform: campaign.platform,
      file: path.join(campaignsDir, f),
      assets: scope ? (scope.assets || []) : (campaign.assets || []),
      accounts: campaign.accounts || [],
      outOfScope: scope?.outOfScope ?? [],
      knownIssues: scope?.stats?.knownIssues ?? null,
      scopeCapturedAt: scope ? (scope.capturedAt ?? null) : (campaign._scope_confirmed?.captured_at ?? null),
      automationPolicy: campaign.automation_policy ?? null,
      specPath,
      specPaths,
      specNeedsIdentities: campaign.spec_needs_identities ?? 2,
      scopeDir: scope?._dir ?? null,
      rewards: scope?.rewards ?? campaign._scope_confirmed?.rewards ?? null,
      hypotheses: orderHypotheses(campaign.hypotheses || []),
    });
  }
  out.sort((a, b) => a.platform.localeCompare(b.platform) || a.slug.localeCompare(b.slug));
  return out;
}
