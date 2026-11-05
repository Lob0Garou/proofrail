// Classificacao de alvo. Funcao pura: sem rede, sem disco, sem relogio.
//
// Regra central da esteira: ela NAO para no alvo bloqueado. Ela classifica o
// bloqueio e segue para o proximo. O que fica registrado e' o PRIMEIRO
// impedimento — o que trava de fato — e a acao unica que destrava.

export const STATUS = ['validated', 'rejected', 'inconclusive', 'standby', 'error', 'pending'];

export const UNBLOCK = {
  'escopo-vazio': 'Rodar o scope-first; o programa nao devolveu ativo elegivel.',
  'escopo-vencido': 'Recapturar escopo: a captura tem mais de 7 dias e escopo velho e desconhecido, nao memoria.',
  'sem-spec': 'Escrever a spec do replay/v2 (classe + oracle + fase de confound) a partir de uma hipótese aberta da campanha e de um endpoint com sinal.',
  'sem-contas': 'Criar as identidades A e B. Sem duas contas independentes nao existe teste BOLA.',
  'conta-saturada': 'Criar uma segunda identidade independente; a atual ja cumpriu o papel.',
  'base-duplicata-incompleta': 'Capturar os known issues (Bugcrowd: sessao autenticada) ou o corpus de relatorios divulgados.',
  'sem-superficie-web': 'Resolver os ativos: o escopo nao declara nenhum host HTTP testavel.',
  'regra-de-automacao-ausente': 'Ler o brief autenticado e registrar a politica de automacao antes de disparar request.',
};

const STALE_MS = 7 * 24 * 3600 * 1000;

/** Conta hosts HTTP testaveis declarados no escopo. */
export function webAssets(assets = []) {
  return assets.filter((a) => {
    const t = String(a.type || '').toLowerCase();
    if (t === 'mobile' || t === 'google_play_app_id' || t === 'apple_store_app_id') return false;
    if (t === 'cidr' || t === 'ip') return false;
    return true;
  });
}

/**
 * @param {{slug:string, assets:Array, accounts:Array, specPath:?string,
 *          scopeCapturedAt:?string, knownIssues:?object,
 *          automationPolicy:?string, previous:?object}} t
 * @param {{now?:number}} [ctx]
 * @returns {{status:string, reason:string, unblock:string|null, detail?:string}}
 */
export function classify(t, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const assets = t.assets || [];
  const web = webAssets(assets);

  if (!assets.length) return { status: 'standby', reason: 'escopo-vazio', unblock: UNBLOCK['escopo-vazio'] };
  if (!web.length) return { status: 'standby', reason: 'sem-superficie-web', unblock: UNBLOCK['sem-superficie-web'] };

  const captured = t.scopeCapturedAt ? Date.parse(t.scopeCapturedAt) : NaN;
  if (!Number.isFinite(captured)) {
    return { status: 'standby', reason: 'escopo-vencido', unblock: UNBLOCK['escopo-vencido'] };
  }
  if (now - captured > STALE_MS) {
    return {
      status: 'standby', reason: 'escopo-vencido', unblock: UNBLOCK['escopo-vencido'],
      detail: `capturado em ${t.scopeCapturedAt}`,
    };
  }

  if (!t.specPath) {
    // sem spec ainda pode haver trabalho: a varredura de superficie roda igual.
    // O detalhe e' a PAUTA — hipotese aberta da campanha e endpoint com sinal,
    // que e' o que a spec precisa consumir.
    const open = (t.hypotheses || []).filter((h) => /open|-untested|aberta/i.test(String(h.state || '')));
    const sinais = ctx.surface?.deepenReal ?? 0;
    const partes = [];
    if (open.length) partes.push(`${open.length} hipótese(s) aberta(s): ${open.slice(0, 2).map((h) => h.id).join(', ')}`);
    if (sinais) partes.push(`${sinais} endpoint(s) com sinal`);
    partes.push(`${web.length} host(s) para varrer`);
    return { status: 'standby', reason: 'sem-spec', unblock: UNBLOCK['sem-spec'], detail: partes.join(' · ') };
  }

  const needs = t.specNeedsIdentities ?? 2;
  const accounts = (t.accounts || []).length;
  if (accounts < needs) {
    return {
      status: 'standby', reason: 'sem-contas', unblock: UNBLOCK['sem-contas'],
      detail: `spec exige ${needs} identidades, campanha tem ${accounts}`,
    };
  }

  // Gate de duplicata. So o Bugcrowd expoe "known issues"; HackerOne, Intigriti e
  // YesWeHack nao tem o conceito. Exigir `knownIssues` deles travava o alvo para
  // sempre — 14 dos 18 alvos nunca poderiam chegar a `pending`, e a esteira
  // rodava ciclo apos ciclo sem executar um unico spec. O gate vale quando a
  // plataforma oferece o dado; quando nao oferece, o sinal de saturacao que
  // existe (reports/asset capturado no escopo) e' declarado como cobertura
  // parcial e o alvo SEGUE. Unknown nao e' impedimento, e' lacuna registrada.
  //
  // Plataforma ausente => assume que o gate vale. Errar para o lado conservador
  // aqui e' barato (o alvo espera); errar para o lado permissivo seria disparar
  // request sem base de duplicata, que e' o que o gate existe para impedir.
  const PLATAFORMAS_SEM_KNOWN_ISSUES = new Set(['hackerone', 'intigriti', 'yeswehack']);
  const plat = String(t.platform || '').toLowerCase();
  const plataformaNaoTemKI = PLATAFORMAS_SEM_KNOWN_ISSUES.has(plat);
  const ki = t.knownIssues;
  const temKnownIssues = !!(ki && !ki.locked && ki.unique != null);
  if (!plataformaNaoTemKI && !temKnownIssues) {
    return {
      status: 'standby', reason: 'base-duplicata-incompleta', unblock: UNBLOCK['base-duplicata-incompleta'],
      detail: ki?.locked ? `known issues responde ${ki.status}` : 'known issues nao capturados',
    };
  }

  if (!t.automationPolicy || /NAO VERIFICADA/i.test(String(t.automationPolicy))) {
    return {
      status: 'standby', reason: 'regra-de-automacao-ausente', unblock: UNBLOCK['regra-de-automacao-ausente'],
    };
  }

  return { status: 'pending', reason: 'pronto', unblock: null };
}

/**
 * Traduz o veredito do engine para o estado da esteira. A esteira nunca
 * promove um alvo a validated por conta propria: so o judge faz isso.
 * @param {{verdict:string}} r
 */
export function outcomeFromVerdict(r) {
  const v = String(r?.verdict || '');
  if (v === 'proven') return { status: 'validated', reason: 'engine:proven' };
  // `not-vulnerable` e' um veredito VALIDO do juiz, nao um erro do motor. Ele
  // significa "testei e o alvo resistiu" — trabalho feito, alvo fechado. Antes
  // caia no fallback e virava `error`, o que sujava o placar e deixava o alvo
  // elegivel para re-teste em todo ciclo, gastando requisicao a toa.
  if (v === 'rejected' || v === 'not-proven' || v === 'not-vulnerable') {
    return { status: 'rejected', reason: `engine:${v}` };
  }
  if (v === 'inconclusive') return { status: 'inconclusive', reason: 'engine:inconclusive' };
  return { status: 'error', reason: `engine:${v || 'sem-veredito'}` };
}
