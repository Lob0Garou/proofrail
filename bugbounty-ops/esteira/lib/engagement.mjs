// Engajamento focado: UM alvo, anexado por escopo, com diretorio proprio.
//
// A esteira antiga varria a fila inteira em rodizio e nunca fechava nada. Um
// engajamento troca isso por: o operador anexa o escopo de UM alvo, a esteira
// fixa o alvo, e o objetivo e' o piso de severidade — ela so considera a missao
// cumprida quando existe achado PROVADO pelo juiz com tier >= piso.
//
// estado, journal, STATUS, STOP e log vivem em engagements/<slug>/: dois alvos
// focados nao se sobrescrevem, e o STOP de um nao para o outro.
import fs from 'node:fs';
import path from 'node:path';
import { classifyObservedImpact } from './impact-gate.mjs';
import { DEFAULT_MIN, meetsMin, parseTier, sortCandidates } from './severity.mjs';

const PLATFORMS = ['bugcrowd', 'hackerone', 'intigriti', 'yeswehack'];
const SCOPE_FILES = ['scope.json', 'SCOPE.md'];

export const ENGAGEMENT_STATUS = ['ativo', 'objetivo-atingido', 'parado', 'concluido'];

export function engagementsDir(estDir) {
  return path.join(estDir, 'engagements');
}

export function engagementDir(estDir, slug) {
  return path.join(engagementsDir(estDir), String(slug));
}

/** Arquivos de controle do engajamento (um conjunto por alvo). */
export function engagementFiles(dir) {
  return {
    dir,
    state: path.join(dir, 'state.json'),
    journal: path.join(dir, 'journal.jsonl'),
    stop: path.join(dir, 'STOP'),
    heartbeat: path.join(dir, 'HEARTBEAT'),
    status: path.join(dir, 'STATUS.md'),
    log: path.join(dir, 'esteira.log'),
    focus: path.join(dir, 'focus.json'),
    submit: path.join(dir, 'SUBMITS', 'INDEX.md'),
    submits: path.join(dir, 'SUBMITS'),
    findings: path.join(dir, 'FINDINGS.md'),
    impasse: path.join(dir, 'IMPASSE.md'),
  };
}

/**
 * Aceita qualquer forma que o operador cole: slug puro (`example-program`),
 * pasta de escopo (`bugbounty-ops/scopes/bugcrowd-example-program/`), arquivo de
 * escopo (`.../scope.json`) ou o prefixo com plataforma (`bugcrowd-example-program`).
 */
export function slugFromToken(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  let p = raw.replace(/[\\/]+$/, '');
  const base = path.basename(p);
  const parent = path.basename(path.dirname(p));
  const candidates = SCOPE_FILES.includes(base) || base === 'SCOPE.md' ? [parent] : [base, parent];
  for (const c of candidates) {
    if (!c || c === '.' || c === '..') continue;
    const stripped = c.replace(new RegExp(`^(${PLATFORMS.join('|')})-`, 'i'), '');
    const slug = stripped.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
    if (slug && slug !== '.' && slug !== '..' && /[a-z0-9]/.test(slug)) return slug;
  }
  return null;
}

/** Todo engajamento com diretorio em disco (mesmo parado). */
export function listEngagements(estDir) {
  const d = engagementsDir(estDir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((slug) => fs.existsSync(path.join(d, slug, 'state.json')) || fs.existsSync(path.join(d, slug, 'focus.json')))
    .sort();
}

/**
 * Resolve o engajamento alvo de um comando.
 *  - com `--target`: aquele alvo (cria o diretorio, nao o estado)
 *  - sem `--target`: o unico existente
 *  - ambiguidade devolve erro com a lista em vez de adivinhar
 */
export function resolveEngagement(estDir, token) {
  const slug = slugFromToken(token);
  if (slug) return { slug, dir: engagementDir(estDir, slug) };
  const all = listEngagements(estDir);
  if (all.length === 1) return { slug: all[0], dir: engagementDir(estDir, all[0]) };
  if (!all.length) return { error: 'nenhum engajamento: passe --target <slug> ou anexe um escopo' };
  return { error: `vários engajamentos (${all.join(', ')}): passe --target <slug>` };
}

export function writeFocus(dir, focus) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'focus.json'), JSON.stringify({ ...focus, at: new Date().toISOString() }, null, 2) + '\n');
}

export function readFocus(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'focus.json'), 'utf8')); } catch { return null; }
}

/**
 * Valida um escopo anexado antes de aceitar o alvo.
 * Recusa o que a esteira nao consegue usar — e diz o que falta, sem inventar.
 * @returns {{ok:boolean, slug?:string, problems?:string[], scope?:object}}
 */
export function inspectScope(scope, now = Date.now()) {
  const problems = [];
  if (!scope || typeof scope !== 'object') return { ok: false, problems: ['scope.json ilegivel'] };
  const slug = slugFromToken(scope.slug);
  if (!slug) problems.push('escopo sem `slug`');
  if (!PLATFORMS.includes(String(scope.platform || '').toLowerCase())) problems.push(`plataforma fora de ${PLATFORMS.join('/')}`);
  const assets = Array.isArray(scope.assets) ? scope.assets : [];
  if (!assets.length) problems.push('escopo sem ativo elegivel (programa privado, vazio ou nao capturado)');
  const captured = Date.parse(scope.capturedAt);
  if (!Number.isFinite(captured)) problems.push('escopo sem `capturedAt` — captura sem data e desconhecida, nao memoria');
  else if (captured > now) problems.push('capturedAt is in the future');
  else if (now - captured > 7 * 86400000) problems.push(`captura de ${scope.capturedAt} tem mais de 7 dias: recapturar antes de mirar`);
  return problems.length
    ? { ok: false, slug, problems, scope }
    : { ok: true, slug, problems: [], scope };
}

/**
 * O objetivo e' um PISO, nao um teto. Conta so achado com veredito `proven` do
 * juiz e severidade declarada que atinge o piso.
 */
function candidateHasEvidence(candidate) {
  if (!candidate.artifact) return false;
  try {
    const file = fs.statSync(candidate.artifact).isDirectory()
      ? path.join(candidate.artifact, 'result.json') : candidate.artifact;
    return classifyObservedImpact(JSON.parse(fs.readFileSync(file, 'utf8'))).access;
  } catch { return false; }
}

export function objectiveState(state, min = DEFAULT_MIN) {
  const piso = parseTier(min) || DEFAULT_MIN;
  const cands = sortCandidates(state?.targets?.[state?.focus?.slug]?.candidates || []);
  const validos = cands.filter((c) => c.verdict === 'proven' && meetsMin(c.severity, piso) && candidateHasEvidence(c));
  const provadosSemTier = cands.filter((c) => c.verdict === 'proven' && !parseTier(c.severity));
  return {
    met: validos.length > 0,
    min: piso,
    validos,
    provadosSemTier,
    best: validos[0] || cands[0] || null,
    faltando: validos.length ? [] : provadosSemTier.length
      ? ['proven sem severidade: declarar `severity` na spec (P1..P5)']
      : [`nenhum achado com evidência validada ≥ ${piso} ainda`],
  };
}

