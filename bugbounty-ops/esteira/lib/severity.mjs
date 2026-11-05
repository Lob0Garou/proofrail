// Severidade de candidato a submit.
//
// A esteira tem PISO, nao teto: o objetivo de um engajamento focado e' fechar com
// PELO MENOS um P3 comprovado. P1 e' o topo da escala (P1 > P2 > P3 > P4 > P5),
// entao "pelo menos P3" = rank <= 3.
//
// Funcao pura: sem disco, sem rede, sem relogio. Quem declara a severidade e' a
// SPEC (campo `severity`), nunca a esteira. Spec sem severidade produz candidato
// sem faixa — honesto, e o objetivo continua aberto ate alguem declarar.

export const TIERS = ['P1', 'P2', 'P3', 'P4', 'P5'];
export const DEFAULT_MIN = 'P3';

/** Normaliza "p3", "P3", " P3 " -> "P3"; qualquer outra coisa -> null. */
export function parseTier(v) {
  const m = String(v ?? '').trim().toUpperCase().match(/^P([1-5])$/);
  return m ? `P${m[1]}` : null;
}

/** P1=1 ... P5=5. Tier invalido vai para o fim (99). */
export function tierRank(tier) {
  const t = parseTier(tier);
  return t ? TIERS.indexOf(t) + 1 : 99;
}

/** true quando `sev` atinge o piso. Severidade ausente NUNCA atinge. */
export function meetsMin(sev, min = DEFAULT_MIN) {
  const s = parseTier(sev);
  const m = parseTier(min);
  if (!s || !m) return false;
  return tierRank(s) <= tierRank(m);
}

/** Severidade declarada pela spec. `severity` e' o campo; `vrt` e' aceito. */
export function severityFromSpec(spec) {
  return parseTier(spec?.severity) || parseTier(spec?.vrt) || null;
}

/** Faixa de recompensa declarada no escopo para o tier, se houver. */
export function rewardOf(rewards, tier) {
  const t = parseTier(tier);
  const r = t ? rewards?.[t] : null;
  const money = Array.isArray(r) ? r.filter(Boolean) : [];
  return money.length ? money.join('–') : null;
}

/** Rotulo curto para STATUS/SUBMIT: "P3 ($300–$750)" ou "severidade não declarada". */
export function tierLabel(tier, rewards) {
  const t = parseTier(tier);
  if (!t) return 'severidade não declarada';
  const money = rewardOf(rewards, t);
  return money ? `${t} (${money})` : `${t} (sem recompensa declarada)`;
}

/** Mais grave primeiro; sem severidade por ultimo. Empate: o mais recente vence. */
export function sortCandidates(list = []) {
  return [...list].sort((a, b) => tierRank(a.severity) - tierRank(b.severity) || String(b.at).localeCompare(String(a.at)));
}
