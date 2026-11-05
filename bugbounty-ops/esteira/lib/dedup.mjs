// Risco de duplicata por programa — diagnóstico, não palpite.
//
// A pergunta não é "o programa é famoso?", é "qual a chance de alguém já ter
// batido neste mesmo ativo antes de mim?". Três forças respondem isso:
//
//   1. pressão  = relatórios por ativo por trimestre. Muita gente, poucos ativos
//                 -> cada centímetro já foi andado.
//   2. saturado = histórico resolvido. Programa que já pagou 2.000 vezes tem
//                 hash de duplicata grande.
//   3. novidade = dias desde o ativo MAIS NOVO do escopo. Ativo criado ontem
//                 está vazio de relatórios; o mesmo programa pode ser novo
//                 onde importa.
//
// O ponto central: programa velho e saturado pode ter ativo novo. É por isso
// que a novidade é medida por ATIVO, não por programa.

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const DEDUP = {
  PRESSURE_CEILING: 20,   // 20 relatórios/ativo/90d = pressão máxima
  RESOLVED_CEILING: 1000, // 1.000 relatórios resolvidos = saturação máxima
  FRESH_DAYS: 90,         // ativo com <=90 dias conta como novo
  W_PRESSURE: 40,
  W_RESOLVED: 30,
  W_FRESH: 30,
};

/**
 * @param {object} p
 * @param {number|null} p.reports90d     relatórios recebidos nos últimos 90 dias
 * @param {number|null} p.resolved       relatórios resolvidos no histórico
 * @param {number}      p.eligibleAssets ativos elegíveis
 * @param {number|null} p.newestAssetAgeDays  dias desde o ativo mais novo (null = desconhecido)
 * @param {number}      [p.newAssets30d] ativos criados nos últimos 30 dias
 * @returns {{risk:number, band:string, parts:object, unknown:string[]}}
 */
export function dupScore({ reports90d, resolved, eligibleAssets, newestAssetAgeDays, newAssets30d = 0 }) {
  const unknown = [];
  const assets = Math.max(1, Number(eligibleAssets) || 1);

  let pressurePart = 0;
  let pressure = null;
  if (Number.isFinite(reports90d)) {
    pressure = reports90d / assets;
    pressurePart = DEDUP.W_PRESSURE * clamp01(pressure / DEDUP.PRESSURE_CEILING);
  } else unknown.push('reports90d');

  let resolvedPart = 0;
  if (Number.isFinite(resolved)) {
    resolvedPart = DEDUP.W_RESOLVED * clamp01(resolved / DEDUP.RESOLVED_CEILING);
  } else unknown.push('resolved');

  // Novidade: só desconta risco quando há data. Sem data, não inventa alívio —
  // plataforma que não expõe timestamp fica com o risco cheio, e isso é honesto.
  let freshPart = 0;
  if (Number.isFinite(newestAssetAgeDays)) {
    freshPart = DEDUP.W_FRESH * clamp01(DEDUP.FRESH_DAYS / Math.max(1, newestAssetAgeDays));
  } else unknown.push('newestAssetAgeDays');

  const risk = Math.round(Math.max(0, Math.min(100, pressurePart + resolvedPart - freshPart)));

  // Cobertura = quanto do sinal existia. Sem isso, plataforma que não expõe data
  // sai com risco 0 e parece o paraíso — quando na verdade é só terra sem medição.
  const knownPoints = (Number.isFinite(reports90d) ? DEDUP.W_PRESSURE : 0)
    + (Number.isFinite(resolved) ? DEDUP.W_RESOLVED : 0)
    + (Number.isFinite(newestAssetAgeDays) ? DEDUP.W_FRESH : 0);
  const coverage = knownPoints / 100;

  const band = coverage < 0.5
    ? 'indeterminado'
    : risk >= 70 ? 'alto' : risk >= 45 ? 'médio' : risk >= 20 ? 'baixo' : 'muito baixo';

  return {
    risk,
    band,
    coverage: Math.round(coverage * 100) / 100,
    parts: {
      pressure: pressure == null ? null : Math.round(pressure * 100) / 100,
      pressurePart: Math.round(pressurePart),
      resolvedPart: Math.round(resolvedPart),
      freshPart: Math.round(freshPart),
      newAssets30d,
    },
    unknown,
  };
}

/** Só a parte de novidade do escopo: quando nasceu o ativo mais novo e quantos são recentes. */
export function assetFreshness(assets, now = Date.now()) {
  const dated = (assets || []).filter((a) => a.created_at && Number.isFinite(Date.parse(a.created_at)));
  if (!dated.length) return { newestAssetAgeDays: null, newAssets30d: 0, datedCount: 0, total: (assets || []).length };
  const ages = dated.map((a) => (now - Date.parse(a.created_at)) / 86400000);
  const newest = Math.min(...ages);
  return {
    newestAssetAgeDays: Math.round(newest),
    newAssets30d: ages.filter((d) => d <= 30).length,
    datedCount: dated.length,
    total: (assets || []).length,
  };
}
