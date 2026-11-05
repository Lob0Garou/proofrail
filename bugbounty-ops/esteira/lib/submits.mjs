// Submissões: um achado provado = um documento próprio, emitido na hora.
//
// A regra que isso protege: dois P2 independentes são DOIS submits, não um
// relatório com dois itens. Um P3 não espera os P2 ficarem prontos, e um P2
// provado não espera o piso ser atingido para sair do forno — o piso decide
// quando o ENGAJAMENTO fecha, não o que já pode ser despachado.
//
// Agrupamento só quando a conexão é declarada na spec (`chain`): achados que só
// dividem o mesmo host continuam separados, porque a plataforma paga por achado.
// Documento emitido não é reescrito enquanto a prova não muda — edição humana
// no texto sobrevive ao próximo ciclo.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MIN, meetsMin, parseTier, tierLabel, tierRank } from './severity.mjs';
import { classifyObservedImpact, gateBanner } from './impact-gate.mjs';

const sanitize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Hash curto e estável de spec+artefato: identifica a prova, não o texto. */
export function proofHash(cand) {
  const src = `${cand.spec || ''}|${cand.artifact || ''}|${cand.hypothesis || ''}`;
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

export function submitId(cand) {
  const sev = (parseTier(cand.severity) || 'px').toLowerCase();
  return `${sev}-${sanitize(cand.hypothesis || cand.oracle || 'achado')}-${proofHash(cand)}`;
}

/**
 * Agrupa só o que a spec declarou conectado (`chain`). Sem `chain`, cada achado
 * provado é um submit. A severidade do grupo é a mais alta entre os membros.
 */
export function groupCandidates(candidates = []) {
  const by = new Map();
  for (const c of candidates.filter((x) => x.verdict === 'proven')) {
    const key = c.chain || c.id || submitId(c);
    const g = by.get(key) || { key, members: [] };
    g.members.push(c);
    if (!g.severity || tierRank(c.severity) < tierRank(g.severity)) g.severity = c.severity;
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => tierRank(a.severity) - tierRank(b.severity) || a.key.localeCompare(b.key));
}

export function submitsDir(dir) {
  return path.join(dir, 'SUBMITS');
}

export function submitPath(dir, key) {
  return path.join(submitsDir(dir), `${sanitize(key)}.md`);
}

export function submittedMark(dir, key) {
  return path.join(submitsDir(dir), `${sanitize(key)}.submitted.json`);
}

export function readSubmitted(dir, key) {
  try { return JSON.parse(fs.readFileSync(submittedMark(dir, key), 'utf8')); } catch { return null; }
}

export function markSubmitted(dir, key, data = {}) {
  fs.mkdirSync(submitsDir(dir), { recursive: true });
  fs.writeFileSync(submittedMark(dir, key), JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2) + '\n');
}

/**
 * Lê o result.json da prova. O stdout da engine só entrega o diretório; os fatos
 * que o triager cobra (reason, impact_basis, passos) estão no arquivo, não no
 * candidato. Falha de leitura devolve null — o documento declara a lacuna em vez
 * de inventar o passo.
 */
export function readProof(artifact) {
  if (!artifact) return null;
  // `artifact` chega das duas formas: o CAMINHO do result.json ou o DIRETORIO da
  // prova. Antes assumia arquivo e fazia `dirname` — quando vinha o diretorio,
  // subia para o pai, nao achava result.json e devolvia null. O documento entao
  // se declarava "sem exchange" com os six exchange-*.req.txt ali do lado.
  let dir = artifact;
  try {
    if (fs.statSync(artifact).isFile()) dir = path.dirname(artifact);
  } catch {
    // caminho inexistente: tenta como diretorio mesmo assim, o try abaixo decide
  }
  try {
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    const exchanges = fs.readdirSync(dir)
      .filter((f) => /^exchange-\d+\.req\.txt$/.test(f))
      .sort()
      .map((f) => ({ req: path.join(dir, f), res: path.join(dir, f.replace(/\.req\.txt$/, '.res.txt')) }));
    return { result, exchanges, dir };
  } catch {
    return null;
  }
}

const PHASE_LABEL = { positive: 'controle positivo', attack: 'ataque', negative: 'controle negativo', verify: 'verificação', confound: 'confundidor' };

/** Um passo do juiz vira uma linha numerada que aponta para o exchange bruto. */
function stepLine(step, n, exchanges) {
  const req = step.request || {};
  const res = step.response || {};
  const phase = PHASE_LABEL[step.phase] || step.phase || 'passo';
  const ex = exchanges[n - 1];
  const where = ex ? `request em \`${ex.req}\`, response em \`${ex.res}\`` : 'exchange não gravado';
  const status = res.status != null ? ` → HTTP ${res.status}` : ' → sem response';
  return `${n}. **${phase}** (\`${step.id || '—'}\`, identidade \`${step.identity || '—'}\`): \`${req.method || '—'} ${req.url || '—'}\`${status}. ${where}.`;
}

/**
 * Corpo colável no formulário da Bugcrowd, um achado por documento.
 *
 * O que isto segue, e de onde: `bugcrowd-reporting` §5 (um achado por submissão;
 * cadeia só quando o impacto exige, com cross-reference e nunca a narrativa
 * inteira repetida em cada elo), §3 (pedido de severidade é parágrafo de
 * evidência, nunca substitui reprodução e impacto) e §8.2 (id rastreável).
 * O checklist local `submission-standard-conformance.md` §A exige título sem
 * adjetivo, descrição curta antes do contexto, passos numerados cada um com o
 * request, PoC bruto, impacto separado em demonstrado/não demonstrado, e
 * remediação específica. Severidade não é campo do formulário — é derivada da
 * VRT — então o documento pede avaliação, não "seleciona P2".
 *
 * O que isto não faz: escolher o nó de VRT. A taxonomia muda de versão e o
 * programa remapeia o default; um nó chutado aqui vira P4 automático no
 * formulário. O campo fica em branco, com a hierarquia de busca, para quem
 * submete preencher contra o dropdown vivo.
 */
function docFor(group, { focus, min, rewards, proofs }) {
  const lead = group.members[0];
  const sev = group.severity;
  const below = !meetsMin(sev, min);
  const proof = proofs?.get(group.key) || null;
  const result = proof?.result || null;
  const exchanges = proof?.exchanges || [];
  const chained = group.members.length > 1;
  const target = result?.program || focus?.slug || '—';
  // GATE DURO: o que as respostas gravadas provam, nao o rotulo do juiz.
  // `proven` so' significa acesso quando existe 2xx anonimo no passo de ataque.
  const gate = classifyObservedImpact(result);
  const L = [];

  // Título: a falha técnica, sem adjetivo e sem o nome do ativo em caixa alta.
  L.push(`# ${lead.hypothesis || lead.oracle || 'achado'}`);
  L.push('');
  if (!gate.access) {
    L.push(`> ⛔ **NAO SUBMETIVEL — gate de impacto: \`${gate.level}\`.** ${gateBanner(gate)}`);
    L.push('>');
    L.push(`> Prova tecnica do mecanismo: ${gate.reason}.`);
    L.push('>');
    L.push('> Este documento existe como REGISTRO da hipotese testada, nao como fila de envio. Vira submissao so depois de um passo de ataque com HTTP 2xx anonimo gravado nos exchanges.');
    L.push('');
  }
  L.push('> Rascunho da esteira, um achado por documento, pronto para colar no formulário. Publicar é passo humano — a esteira não submete.');
  L.push('');

  L.push('## Para o formulário (preencher na hora, contra o dropdown vivo)');
  L.push('');
  L.push(`- **Target:** \`${target}\` — conferir que o host testado está na lista in-scope do programa, literal.`);
  L.push('- **VRT:** _não preenchido de propósito._ Buscar no dropdown, nesta ordem, e pegar o nó mais específico que descreva o bug sem exagerar: (1) classe primária, (2) categoria do dado exposto, (3) controle contornado, (4) tipo de endpoint, (5) nó pai genérico `… → Other`. Nó chutado vira severidade default errada.');
  L.push(`- **Technical Severity:** o formulário deriva da VRT; não há campo para "selecionar ${parseTier(sev) || '—'}". ${below ? `A spec declara **${tierLabel(sev, rewards)}**, abaixo do piso ${parseTier(min) || DEFAULT_MIN} — o pedido abaixo argumenta por que ainda vale avaliar.` : `A spec declara **${tierLabel(sev, rewards)}**; se o default da VRT escolhida for mais baixo, o pedido abaixo é o argumento.`}`);
  L.push('');

  // §3: o pedido de severidade vem primeiro no corpo, e é evidência, não slogan.
  L.push('## Severity request — please review before applying the VRT default');
  L.push('');
  if (!gate.access) {
    L.push(`⛔ **Nada aqui pede tier: o gate de impacto (\`${gate.level}\`) nega submissao.** ${gate.reason}. Valide os controles e o efeito antes de pedir severidade.`);
  } else {
    L.push(`The closest VRT node is left blank above on purpose: the taxonomy moves between versions and this program may remap defaults. The spec for this finding declares **${tierLabel(sev, rewards)}**. Please evaluate at that tier, standalone${chained ? `, or higher if the chain below holds` : ''}, because:`);
    L.push('');
    L.push(`1. **Demonstrated effect** — the judge returned \`${result?.verdict || lead.verdict}\` with reason \`${result?.reason || '—'}\` and impact basis \`${result?.impact_basis || lead.impact || '—'}\`. That is the effect actually observed, not the class of the bug.`);
    if (result?.impact_basis && result.impact_basis !== 'write') {
      L.push(`2. **Bound** — impact basis \`${result.impact_basis}\` is the ceiling the proof supports. A higher tier would need an effect this run did not produce, so it is not requested.`);
    } else if (result?.impact_basis === 'write') {
      L.push('2. **Persistence** — the write survived a read-back by the victim identity, so the effect is not a reflected response.');
    } else {
      L.push('2. **Bound** — no `impact_basis` was recorded for this proof, so nothing above the declared tier is requested.');
    }
  }
  L.push('');

  // Descrição curta antes de qualquer contexto — o que está quebrado, não a história.
  L.push('## Summary');
  L.push('');
  L.push(`\`${lead.oracle || '—'}\` on \`${target}\`: ${lead.hypothesis || 'the judge proved the stated hypothesis'}. The proof is the raw request/response pairs referenced below; this paragraph states the break, not the investigation.`);
  L.push('');

  // Passos numerados, cada um com o request e o ponteiro para o bruto.
  L.push('## Steps to reproduce');
  L.push('');
  const steps = Array.isArray(result?.steps) ? result.steps.filter((s) => s?.response) : [];
  if (steps.length) {
    L.push('Each step names the raw exchange file. Re-run from a clean session; do not trust this prose over the file.');
    L.push('');
    steps.forEach((s, i) => L.push(stepLine(s, i + 1, exchanges)));
  } else if (lead.repro) {
    L.push('No per-step record was captured. The only reproduction available is the command below.');
    L.push('');
    L.push('```bash');
    L.push(lead.repro);
    L.push('```');
  } else {
    L.push(`**Gap:** the proof directory has no step record, so this report cannot yet be reproduced by a third party from the text alone. Proof directory: \`${lead.artifact || '—'}\`.`);
  }
  L.push('');

  // PoC = request + response bruto, nunca resumo.
  L.push('## Proof of concept');
  L.push('');
  L.push(`- prova: \`${lead.artifact || '—'}\``);
  if (exchanges.length) {
    L.push(`- ${exchanges.length} raw exchange pair(s), redacted by the engine before write:`);
    for (const ex of exchanges) L.push(`  - \`${ex.req}\` / \`${ex.res}\``);
  } else {
    L.push('- **Gap:** no `exchange-NN.req.txt` alongside `result.json`. A report without the raw pair is not submittable.');
  }
  L.push(`- spec: \`${lead.spec || '—'}\``);
  L.push('');

  // Impacto separado: o que a prova sustenta e o que ela não sustenta.
  L.push('## Impact');
  L.push('');
  L.push(`**Demonstrated.** ${result?.impact_basis ? `Impact basis \`${result.impact_basis}\` (\`${result.reason}\`).` : 'No impact basis recorded — treat the demonstrated effect as unstated until `result.json` is read.'} ${lead.attribution ? `Attribution claim: ${lead.attribution}.` : ''}`);
  L.push('');
  L.push('**Not demonstrated.** No end-to-end effect beyond the impact basis above was produced by this run. Account takeover, data exfiltration at scale, or fund movement are not claimed here unless a step above shows them.');
  L.push('');

  // Remediação específica por base de impacto — "sanitize inputs" não passa no checklist.
  L.push('## Remediation');
  L.push('');
  const basis = result?.impact_basis || lead.impact;
  if (basis === 'read' || basis === 'write') {
    L.push(`Authorize \`${lead.oracle}\` on the object owner, not on the caller identity. A \`${basis}\` impact basis means the attacker identity reached an object the positive control showed belongs to someone else — reject the request when the authenticated subject does not own the referenced object, and do it before the handler, not in the response filter.`);
  } else if (basis === 'auth-bypass') {
    L.push('Reject the request at the authentication boundary. The proof shows an unauthenticated or tampered caller reaching a resource the positive control only served to an authenticated identity; a downstream check does not repair that.');
  } else if (basis === 'race') {
    L.push('Serialize the guarded action on the resource and re-check the invariant inside the same transaction. The proof shows a burst exceeding the baseline the control established; a check-then-act outside the lock is what the burst beat.');
  } else {
    L.push(`**Gap:** no impact basis, so no specific fix is stated. Guessing one (\`sanitize all inputs\`) would misrepresent the bug. Read \`${lead.artifact || 'result.json'}\` and name the exact check that failed.`);
  }
  L.push('');

  // §5: cadeia é cross-reference, não narrativa colada. Parceiro ainda não
  // submetido é referência interna, nunca UUID inventado.
  if (chained) {
    L.push('## Chain partners (not yet filed — internal references only)');
    L.push('');
    L.push('These primitives share one declared chain and are listed together because the impact needs all of them. Each has its own fix surface. No submission UUID exists yet; do not backfill one — the platform does not allow editing a submitted report. Replace each internal id below with the real submission id at filing time.');
    L.push('');
    for (const m of group.members) L.push(`- **${sanitize(m.id || submitId(m))}** — ${m.hypothesis || m.oracle || '—'} (${tierLabel(m.severity, rewards)})`);
    L.push('');
    L.push('## Chain context');
    L.push('');
    L.push(`This document is 1 of ${group.members.length} primitives in chain \`${group.key}\`. The chained severity is the highest tier among them (${tierLabel(sev, rewards)}). Each primitive keeps its own demonstrated impact; none of them is independently the chained tier.`);
    L.push('');
  }

  // Higiene que o triager precisa ver no corpo, não só no processo.
  L.push('## Notes for triagers');
  L.push('');
  L.push('- Test accounts used the program alias where the program requires one. No second account was created to bypass a lock.');
  L.push('- Session material in the raw exchanges was redacted by the engine before this document was written. Rotate the test session after filing; logout alone does not prove the old credential is dead.');
  L.push('- State-changing steps, if any, need their restoration stated here before filing. If restoration was impossible, say so — do not imply it.');
  L.push('');

  L.push('---');
  L.push(`id: \`${sanitize(group.key)}\` · plataforma: ${focus?.platform || '—'} · escopo capturado em ${focus?.capturedAt || '—'} · gerado em ${new Date().toISOString()}`);
  L.push('Uma submissão por arquivo. Não juntar dois achados independentes neste documento para "render melhor".');
  return L.join('\n') + '\n';
}

/**
 * Emite/atualiza os documentos. Devolve o que foi escrito agora.
 * Reescrita só quando o artefato da prova muda; senão devolve `fresh: false`.
 */
export function emitSubmits(dir, { focus, state, min = DEFAULT_MIN, rewards = null } = {}) {
  const cands = Object.values(state?.targets || {}).flatMap((t) => t.candidates || []);
  const groups = groupCandidates(cands);
  fs.mkdirSync(submitsDir(dir), { recursive: true });
  // Uma leitura por grupo, fora do gerador: docFor não toca disco.
  const proofs = new Map(groups.map((g) => [g.key, readProof(g.members[0]?.artifact)]));
  const out = [];
  for (const g of groups) {
    const p = submitPath(dir, g.key);
    const lead = g.members[0];
    let prior = null;
    try { prior = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').match(/prova: `([^`]+)`/) : null; } catch { prior = null; }
    const same = prior && prior[1] === (lead.artifact || '');
    if (!same) fs.writeFileSync(p, docFor(g, { focus, min, rewards, proofs }));
    out.push({
      id: sanitize(g.key), path: p, severity: g.severity,
      hypothesis: lead.hypothesis || lead.oracle || null,
      below: !meetsMin(g.severity, min), fresh: !same,
      submitted: readSubmitted(dir, g.key),
      gate: proofs.get(g.key)?.result ? classifyObservedImpact(proofs.get(g.key).result) : { level: 'no-proof', access: false },
    });
  }
  return out;
}

export function renderSubmitIndex(dir, submits, { min = DEFAULT_MIN, rewards = null } = {}) {
  const L = [];
  L.push('# SUBMITS — um documento por achado');
  L.push('');
  L.push('> Independentes são independentes: cada arquivo desta lista vira UMA submissão.');
  L.push(`> Piso do engajamento: **${parseTier(min) || DEFAULT_MIN}** (o que está abaixo do piso também foi provado e também vale enviar).`);
  L.push('');
  if (!submits.length) L.push('_nenhum achado provado ainda_');
  if (submits.length) {
    L.push('| | severidade | hipótese | estado | documento |');
    L.push('|---|---|---|---|---|');
    for (const s of submits) {
      // Gate de impacto: evidência insuficiente no ataque, o item NAO entra na fila.
      const gate = s.gate;
      const hold = gate && !gate.access;
      const base = s.submitted
        ? `submetido ${String(s.submitted.at).slice(0, 10)}${s.submitted.url ? ` (${s.submitted.url})` : ''}`
        : hold
          ? `SEGURAR · gate ${gate.level} · evidência insuficiente`
          : s.below ? 'novo · abaixo do piso' : 'novo';
      L.push(`| | ${tierLabel(s.severity, rewards)} | ${s.hypothesis || '—'} | ${base} | [\`${s.id}.md\`](${path.basename(s.path)}) |`);
    }
  }
  L.push('');
  if (submits.some((s) => s.gate && !s.gate.access)) {
    L.push('> ⛔ Itens **SEGURAR** precisam de evidência adicional antes de entrar na fila de envio.');
    L.push('');
  }
  L.push('Ao enviar, marque: `ctl.mjs mark --target <slug> --id <id> --url <url>` — a lista para de tratar o item como pendente.');
  return L.join('\n') + '\n';
}

export function writeSubmitIndex(dir, submits, opts = {}) {
  const p = path.join(submitsDir(dir), 'INDEX.md');
  fs.mkdirSync(submitsDir(dir), { recursive: true });
  fs.writeFileSync(p, renderSubmitIndex(dir, submits, opts));
  return p;
}
