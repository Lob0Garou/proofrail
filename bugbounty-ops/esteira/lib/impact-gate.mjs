// Interpret recorded evidence conservatively.
/**
 * Classifica o que os passos gravados demonstram.
 * @param {?{steps?:Array}} result result.json da prova
 * @returns {{level:string, access:boolean, status:?number, posStatus:?number, reason:string}}
 */
export function classifyObservedImpact(result) {
  const steps = (Array.isArray(result?.steps) ? result.steps : []).filter((s) => s?.response);
  if (!steps.length) {
    return { level: 'no-proof', access: false, status: null, posStatus: null, reason: 'sem passos gravados na prova' };
  }

  const statusOf = (s) => Number(s?.response?.status) || 0;
  const attacks = steps.filter((s) => s?.phase === 'attack');

  const complete = result.schema === 'replay-result/v2' && result.verdict === 'proven' &&
    steps.some((s) => s.phase === 'positive') && steps.some((s) => s.phase === 'negative');
  const hit = attacks.find((s) => statusOf(s) >= 200 && statusOf(s) < 300);
  if (complete && result.oracle === 'auth-matrix') {
    const headers = hit?.request?.headers;
    const url = hit?.request?.url;
    const queryCredentials = !url || /[?&][^=&]*(?:token|key|secret|session|auth|signature)[^=&]*=/i.test(url);
    const credential = headers && Object.keys(headers).some((k) =>
      /authorization|cookie|token|api[-_]?key|secret|session/i.test(k));
    if (result.reason === 'anon-reached-authed-resource' && result.impact_basis === 'auth-bypass' &&
        headers && !credential && !queryCredentials && typeof hit.response.body === 'string' && hit.response.body.trim()) {
      return { level: 'access-proven', access: true, status: statusOf(hit), reason: 'O juiz confirmou o marcador do recurso protegido sem credenciais nos headers gravados.' };
    }
  } else if (complete && result.oracle && result.reason && result.impact_basis) {
    return { level: 'effect-proven', access: true, status: hit ? statusOf(hit) : null, reason: 'Efeito confirmado pelos controles do oráculo.' };
  }
  if (hit) return { level: 'insufficient-evidence', access: false, status: statusOf(hit), reason: 'O status isolado não demonstra o efeito.' };

  const pos = steps.find((s) => s?.phase === 'positive');
  const posStatus = pos ? statusOf(pos) : null;
  const atkStatus = attacks.length ? statusOf(attacks[0]) : statusOf(steps[steps.length - 1]);

  // Rejeicao DIFERENTE da do controle: o request passou pelo primeiro controle e
  // foi travado por outro. Mecanismo interessante; acesso, nao.
  if (posStatus && atkStatus && atkStatus !== posStatus) {
    return {
      level: 'boundary-crossed', access: false, status: atkStatus, posStatus,
      reason: `controle devolveu HTTP ${posStatus}, ataque devolveu HTTP ${atkStatus} — o request atravessou o primeiro controle e foi travado por outro; NENHUM recurso protegido foi servido`,
    };
  }

  return {
    level: 'blocked', access: false, status: atkStatus || null, posStatus,
    reason: `ataque devolveu HTTP ${atkStatus || '?'}, mesma rejeicao do controle — o request nao atravessou nada`,
  };
}

/** Frase para o cabecalho do documento. Dura, sem adjetivo. */
export function gateBanner(gate) {
  if (!gate || gate.access) return null;
  const linhas = {
    'boundary-crossed': 'O veredito `proven` do juiz significa apenas que a rejeicao do PRIMEIRO controle desapareceu. Os exchanges mostram que o request foi travado por um SEGUNDO controle. Nenhum dado foi acessado. Submeter isto como auth-bypass/P2 e overclaim e vira N/A.',
    'insufficient-evidence': 'O status HTTP por si só não demonstra o efeito. Verifique os controles e o recurso esperado.',
    blocked: 'Os exchanges mostram o mesmo status no controle e no ataque: o request nao atravessou o controle algum. `proven` aqui e artefato de oraculo, nao achado.',
    'no-proof': 'A prova nao tem passos gravados. Nao ha como distinguir acesso de bloqueio.',
  };
  return linhas[gate.level] || linhas['no-proof'];
}
