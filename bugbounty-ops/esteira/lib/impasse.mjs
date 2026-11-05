// Detector de impasse da esteira.
//
// O defeito que este modulo corrige: quando `classify` devolve qualquer coisa
// diferente de `pending`, o ciclo registrava um evento `classify` e dormia. Um
// engajamento real acumulou 192 ciclos `standby/sem-spec` identicos e executou
// o engine UMA vez. Nao havia nada entre "classifiquei o bloqueio" e "durmo":
// o processo era tecnicamente vivo e operacionalmente morto.
//
// A regra: impasse NAO e' estado terminal. Impasse e' gatilho. Quando a mesma
// chave de bloqueio se repete, a esteira sobe um degrau de escalada e escreve a
// ACAO CONCRETA que destrava — nao um aviso, nao um resumo. A sessao le
// IMPASSE.md e executa; o processo continua vivo enquanto isso.
//
// Funcao pura: sem rede, sem disco, sem relogio. Tudo o que muda estado fica em
// run.mjs.

/**
 * Chave estavel do impedimento. Status sozinho nao serve: `standby/sem-spec` e
 * `standby/sem-contas` sao impasses diferentes com a mesma severidade.
 * `error` carrega o codigo de saida porque `engine exit 4` e `engine exit 1` sao
 * bloqueios distintos.
 */
export function impasseKey(cls = {}) {
  const status = String(cls.status || 'unknown');
  const reason = String(cls.reason || 'sem-razao');
  return `${status}:${reason}`;
}

/** Degraus de escalada. O numero de ciclos parados escolhe o degrau. */
export const DEGRAUS = [
  { ate: 2, id: 'observar', titulo: 'Observar', acao: null },
  {
    ate: 5, id: 'rota-metodo', titulo: 'Trocar rota ou metodo',
    acao: 'O bloqueio se repetiu. Mude o VERBO ou o PATH antes de mudar a hipotese: '
      + 'GET<->POST<->PUT, /v2<->/v3<->/v4<->/v5, barra final, //, %2e, maiusculas. '
      + 'Registre qual variante mudou o status; se nenhuma mudou, suba um degrau.',
  },
  {
    ate: 12, id: 'eixo', titulo: 'Trocar de eixo',
    acao: 'Rota e metodo esgotados. Troque a PERGUNTA, nao o parametro: '
      + 'HTTP anonima -> navegador autenticado -> bundle/source map -> '
      + 'contrato/binario/firmware -> esteira/juiz -> caso analogo de outro pesquisador. '
      + 'Repetir o mesmo probe com outro valor NAO e trocar de eixo.',
  },
  {
    ate: 24, id: 'evidencia', titulo: 'Remedir e confrontar fontes',
    acao: 'Antes de culpar o alvo, questione o proprio dado: '
      + '(1) o numero que estou usando foi medido por mim? '
      + '(2) duas fontes discordam em algum ponto? '
      + '(3) usei o namespace certo (conta vs instrucao, header vs query vs body)? '
      + '(4) minha amostra tem tamanho 1? '
      + 'Divergencia entre fontes e o melhor ponto de entrada que existe.',
  },
  {
    ate: Infinity, id: 'escalar', titulo: 'Escalar com snippet colavel',
    acao: 'Impassse sustentado. Pare de cavar sozinho e entregue ao operador o que so ele '
      + 'destrava: o bloqueio NOMEADO com o probe que o demonstra, mais o request COMPLETO '
      + 'colavel (metodo, URL, headers, corpo). Nao devolva "preciso de acesso" — devolva a '
      + 'linha que a pessoa cola no console. Enquanto isso, o processo segue vivo.',
  },
];

/** Degrau correspondente ao numero de ciclos parados. */
export function degrauPara(ciclos) {
  const n = Number(ciclos) || 0;
  for (const d of DEGRAUS) if (n <= d.ate) return d;
  return DEGRAUS[DEGRAUS.length - 1];
}

/**
 * Acao ESPECIFICA por motivo de bloqueio, no primeiro degrau em que agir resolve.
 * O texto generico de DEGRAUS diz a direcao; isto diz o que fazer hoje.
 */
export const ACAO_POR_MOTIVO = {
  'sem-spec': 'Escrever a proxima spec replay/v2 a partir da pauta real: '
    + '`node bugbounty-ops/esteira/ctl.mjs findings --target <slug>`. '
    + 'Uma spec = uma hipotese, com `severity` declarada e fases positive/attack/negative/confound. '
    + 'Sem `severity` o achado existe e o objetivo nunca fecha.',
  'sem-contas': 'Criar a segunda identidade independente na fixture '
    + '`campaigns/<slug>.identities/`. Sem par A/B nao existe BOLA — e BOLA e onde mora P2/P3 '
    + 'em programa multi-tenant.',
  'spec-julgada': 'Toda spec da fila ja foi julgada: o alvo nao tem mais hipotese NUMERADA. '
    + 'Escrever a proxima a partir da pauta real (`ctl.mjs findings --target <slug>`) — e, se '
    + 'houver achado provado, a proxima spec USA esse achado como pre-condicao (fase positive, '
    + '`chain` com o id do submit) em vez de repetir a mesma classe. Spec que repete a classe '
    + 'provada e refinamento, nao avanco.',
  'escopo-vencido': 'Recapturar com `node bugbounty-ops/scope-first.mjs <plataforma> <slug>`. '
    + 'Escopo com mais de 7 dias e desconhecido, nao memoria.',
  'base-duplicata-incompleta': 'Capturar known issues (Bugcrowd exige sessao autenticada) '
    + 'ou o corpus de relatorios divulgados antes de disparar request.',
  'regra-de-automacao-ausente': 'Ler o brief autenticado e gravar a politica de automacao '
    + 'no foco do engajamento.',
  'sem-superficie-web': 'Resolver os ativos: o escopo nao declara host HTTP testavel. '
    + 'Se todos sao contrato/binario/APK, a superficie e outro eixo — nao HTTP.',
  'escopo-vazio': 'O programa nao devolveu ativo elegivel. Recapturar; persistindo, o alvo '
    + 'nao existe para esta esteira e o engajamento deve ser encerrado com motivo.',
};

/** Motivo do bloqueio, sem o prefixo de status (`standby:sem-spec` -> `sem-spec`). */
export function motivoDe(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Atualiza o estado de estagnacao de UM alvo.
 *
 * @param {?{key:string, ciclos:number, desde?:string}} anterior  stall persistido
 * @param {{status:string, reason:string}} cls                    classificacao do ciclo
 * @returns {{key:string, ciclos:number, mudou:boolean, degrau:object, motivo:string,
 *            acao:string, novo:boolean, sustentado:boolean}}
 */
export function detectarImpasse(anterior, cls) {
  const key = impasseKey(cls);
  const mudou = !anterior || anterior.key !== key;
  const ciclos = mudou ? 1 : (Number(anterior?.ciclos) || 0) + 1;
  const degrau = degrauPara(ciclos);
  const motivo = motivoDe(key);
  // Especifico vence generico: se o motivo tem acao propria e o degrau ainda e
  // raso, a acao util e a do motivo. Em degrau alto, a escalada manda mais.
  const especifica = ACAO_POR_MOTIVO[motivo];
  const acao = degrau.id === 'observar' ? null
    : (especifica && degrau.ate <= 12 ? especifica : degrau.acao);
  return {
    key, ciclos, mudou, degrau, motivo, acao,
    novo: mudou,
    sustentado: ciclos >= 3,
    desde: mudou ? null : (anterior?.desde || null),
  };
}

/**
 * Vale registrar no journal? 192 linhas identicas nao sao informacao — sao ruido
 * que esconde o sinal. Grava quando a chave muda, e depois so nos degraus.
 */
export function deveRegistrar(anterior, atual) {
  if (!anterior || anterior.key !== atual.key) return true;
  const antes = degrauPara(anterior.ciclos).id;
  return antes !== atual.degrau.id;
}

/** Renderiza IMPASSE.md — o canal que a sessao le para agir. */
export function renderImpasse({ slug, stall, cls, min = 'P3' }) {
  const d = stall.degrau || degrauPara(stall.ciclos);
  const linhas = [
    `# IMPASSE — ${slug}`,
    '',
    `**${stall.ciclos} ciclo(s) no mesmo bloqueio.** Degrau: \`${d.id}\` — ${d.titulo}.`,
    '',
    `- chave: \`${stall.key}\``,
    `- status: \`${cls?.status ?? '?'}\` · motivo: \`${stall.motivo}\``,
    `- piso do engajamento: ${min}`,
    '',
    '## Acao que destrava',
    '',
    stall.acao ? stall.acao : 'Nenhuma ainda — primeiro ciclo neste bloqueio. Observar.',
    '',
    '## Regra',
    '',
    'Impasse nao e estado terminal: e gatilho. O processo continua vivo enquanto a sessao',
    'executa a acao acima. Bloqueio de uma trilha nao encerra o engajamento — se este motivo',
    'nao tem saida tecnica, a proxima spec tem que vir de outro eixo.',
    '',
    '**P3 e P4 sao dinheiro.** Achado provado nao se descarta por severidade baixa: submete',
    'o P3 e depois tenta subir pelo mesmo receipt. Um achado provado vale mais que dez',
    'hipoteses abertas.',
  ];
  return linhas.join('\n') + '\n';
}
