---
name: proofrail
description: >
  Transforma um ESCOPO ANEXADO em engajamento focado: recebe o SCOPE.md/scope.json
  de UM alvo, fixa o alvo e mantém o processo caçando até existir pelo menos um
  achado comprovado (veredito `proven` do juiz) de severidade ≥ P3, ou até o operador
  mandar parar. Use quando o operador anexar/trouxer um escopo e disser "pega
  esse alvo", "foca nesse", "trabalha nisso até ter algo submetível", "roda a
  esteira nesse programa", "quero acordar com o SUBMIT", "o que deu no alvo X",
  ou para consultar/parar um engajamento em andamento. NÃO use para julgar ou
  publicar o achado (isso é bug-bounty-pre-submission-gate), nem para capturar
  escopo do zero (isso é bug-bounty-scope-first — mas o anexo pode vir dela).
---

# ProofRail — engajamento focado, um submit por achado, piso P3

Receba o anexo. Fixe o alvo. Persista até o piso.

O alvo desta skill não é varrer 18 programas em rodízio: é **um alvo** e um
critério de saída objetivo — **achado `proven` com severidade ≥ P3**, com prova
em artefato e rascunho de submit pronto. Enquanto o critério não fecha, o
processo não para por conta própria. Ele para com P3 comprovado (`--stop-at-p3`),
com `STOP` do operador, ou nunca.

| | processo da esteira | conversa (esta skill) |
|---|---|---|
| onde roda | SO, desacoplado, por engajamento | sessão do DSH |
| custa | zero token | modelo por turno |
| persiste | até o piso ou `STOP` | até fechar o chat |
| estado | `engagements/<slug>/` | — |

**Regra dura: o trabalho é do processo. À conversa cabe anexar, ligar, ler e parar.**
Caçar dentro do chat morre no fim do turno — é o que esta skill existe para evitar.

---

Execute os comandos na raiz do pacote. Configure o replayer como descrito no README.

## 1. Anexo — a entrada obrigatória

O anexo é o escopo já capturado do alvo: `SCOPE.md` + `scope.json`, produto do
`bug-bounty-scope-first`, que o operador arrasta para a sessão. Sem anexo não há
engajamento — a esteira nunca mira um alvo que não foi lido.

```bash
node bugbounty-ops/esteira/ctl.mjs ingest <scope.json | SCOPE.md | pasta>
```

O `ingest` valida e recusa com motivo, sem inventar:

| recusa (exit 2) | significa |
|---|---|
| escopo sem ativo elegível | programa privado, vazio ou captura falhou — sem superfície |
| escopo sem `capturedAt` | captura sem data é desconhecida, não memória |
| captura > 7 dias | recapturar antes de mirar |
| plataforma fora de bugcrowd/hackerone/intigriti/yeswehack | adapter inexistente |

Aceito, ele copia para `bugbounty-ops/scopes/<plataforma>-<slug>/` e escreve o
`focus.json` do engajamento. Nada mais é criado aqui.

## 2. Ligar — alvo fixado, piso declarado

```bash
node bugbounty-ops/esteira/ctl.mjs start --target <slug> --min-severity P3 --stop-at-p3
```

`start` desacopla (`spawn(detached) + unref`), limpa `STOP` antigo, grava
`esteira.pid` no diretório do engajamento e volta na hora. Se já houver
instância viva naquele alvo, avisa e não duplica.

Recusa antes de gastar request (exit 3): alvo com escopo mas **sem campanha** em
`ESTEIRA_REPLAYER_DIR/campaigns/<slug>.json` — sem campanha não há
identidades nem política de automação. Criar a campanha é pré-requisito, e é
rápido (o `_TEMPLATE.json` existe para isso).

**Depois de ligar, uma linha e pronto:** alvo, pid, `STATUS.md`, comando de
parar. Não fique olhando.

Flags (repasse como vierem): `--stop-at-p3` (encerra no piso em vez de aprofundar)
· `--interval 60` · `--max-minutes N` (0 = sem limite) · `--fresh` (zera o run)
· `--no-sweep` · `--no-deepen` · `--verbose`

## 3. O que a esteira faz sozinha, ciclo após ciclo

1. **Varre** cada ativo declarado — um GET no caminho que o escopo autoriza.
2. **Aprofunda**: para cada endpoint descoberto, dispara um irmão de controle
   `__nc_<random>` e compara. Igual = catch-all do SPA, descarta; diferente =
   endpoint real; 401/403 = existe e exige algo. Sem isso a fila de spec nasce
   de link de menu que responde 200 em qualquer coisa.
3. **Classifica** o impedimento vinculante e registra a ação única que destrava.
4. **Executa uma spec por ciclo** — `replay-<slug>.json` e as irmãs
   `replay-<slug>.<n>.json` / `replay-<slug>-<hipotese>.json`. Uma spec é uma
   hipótese. O juiz é determinístico, não é modelo. Spec já julgada só volta
   quando o arquivo muda (mtime).
5. **Emite o submit no instante do `proven`**, um documento por achado, em
   `SUBMITS/<id>.md`. Dois P2 e um P3 independentes são três arquivos, escritos
   à medida que cada um é provado — o segundo não espera o terceiro, e nenhum
   espera o piso. Só `chain` declarado na spec junta elos no mesmo documento.
   O documento é corpo de formulário Bugcrowd, não índice: título sem adjetivo,
   pedido de severidade no topo (a VRT fica em branco — o dropdown é vivo e um
   nó chutado vira P4 automático), descrição curta, passos numerados cada um
   apontando para o `exchange-NN.req.txt`, impacto separado em demonstrado e
   não demonstrado, e remediação específica à base de impacto. Cadeia vira
   cross-reference com id interno, nunca UUID inventado. A linha `prova:` fica
   no formato fixo — é ela que impede a reemissão de sobrescrever edição humana.
6. **O piso fecha o engajamento, não o despacho.** `proven` abaixo do piso sai
   marcado `abaixo do piso` e continua submetível. O processo segue caçando o
   resto até um `proven` ≥ piso (`--stop-at-p3` encerra) ou `STOP`.

Ela não inventa hipótese, não escreve spec, não cria conta. Isso é a tripulação.
O operador revisa os rascunhos e autoriza o envio.

## 4. A caça — `shadow-hunt` na sessão, a esteira no relógio

A esteira mede e executa; a inteligência vem da `shadow-hunt`, apontada para o
mesmo `SCOPE.md`. Enquanto ela roda, a sessão trabalha nos dois insumos que só o
agente produz, **na ordem que a severidade manda**:

1. **Contas** — as duas identidades independentes (A e B) na fixture de
   `campaigns/<slug>.identities/`. Sem par A/B não existe BOLA/BOLA-escrita, que
   é onde mora P2/P3 em programa multi-tenant.
2. **Specs** — uma por hipótese, com `severity` declarada (`P1`..`P5`). Campo
   `severity` omitido é spec aceita e achado que nunca fecha o objetivo.
   Nome: `scripts/replay-<slug>.json` para a primeira, e
   `replay-<slug>.<n>.json` ou `replay-<slug>-<hipotese>.json` para as seguintes.
   Sem `chain` na spec, cada `proven` vira um submit próprio. `chain` igual em
   duas specs junta os elos num documento só — use só quando a conexão for
   necessária para o achado existir.
   A pauta sai de `ctl.mjs findings --target <slug>`, não de palpite.

Ordem de ataque dentro do alvo é um número, não uma preferência. Cada
hipótese aberta ganha uma pontuação e a spec sai da maior para a menor:

| termo | valor | por quê |
|---|---|---|
| base por classe | `rce` 10 · `sqli`/`auth-bypass`/`ato`/`ssti`/`deser` 9 · `idor`/`bola`/`bac`/`ssrf`/`jwt`/`saml`/`business-logic` 8 · `secret`/`info-disclosure` 6 · `xss`/`open-redirect`/`cors` 3 | é a ordem em que o programa paga, não a ordem alfabética do banco |
| casa com o `instruction` do ativo | +6 | o programa disse onde ele mesmo acha que sangra; ignorar isso para varrer em ordem alfabética é desperdício |
| endpoint casa `/billing\|payment\|checkout\|invoice\|subscription\|order/` | +4 | dinheiro tem faixa declarada; o resto disputa |
| endpoint `real` no deepen | +3 | medido, não adivinhado |
| endpoint `protegido` (401/403) | +1 | existe e exige algo; não é morto |
| `knownIssues` do escopo descreve a mesma classe | +5 | known issue é a régua de *o que o programa já pagou*, não de duplicata — sobe, não desce |
| o operador citou a classe nas instruções do turno | +8 | instrução explícita vence o default |
| `rewards` não declara valor para o tier | −2 | faixa sem preço é achado que não fecha o objetivo |

Empate quebra por `tierRank` da spec, depois por nome. Sem isso a tripulação
escolhe a hipótese que está na mão, e a que está na mão é quase sempre a de
menor impacto.

**A pauta não é só hipótese aberta.** O agente de onde isto saiu roda
`recon → strategy → hunt → verify → chain → refine → finish`, e a fase que falta
na esteira é a do meio: `chain` e `refine` acontecem *depois* do primeiro
`proven`, não antes. O piso fecha o objetivo; não fecha a caça. Com um achado
provado, a próxima spec não é "a próxima hipótese aberta" — é a que **usa o
achado como pré-condição**:

1. o artefato provado vira a fase `positive` da spec seguinte, com `chain` igual
   ao id do submit que o produziu;
2. a classe sobe um degrau: leitura vira escrita, escrita vira ação em nome de
   outro, ação vira persistência. Spec que repete a mesma classe do achado
   provado é refinamento, não cadeia, e não leva `chain`;
3. `free-roam` só existe quando a pauta ordenada está vazia. Caçar sem hipótese
   numerada é o fallback, e o `journal.jsonl` registra `event: freeroam` para
   que a sessão seguinte saiba que aquilo não foi escolha.

Dedupe antes de escrever a spec. Dois endpoints que normalizam para a mesma
rota — UUID, inteiro e hash trocados por `{id}` — são **uma** hipótese, não
três. A chave é `sha256(rota-normalizada + "|" + classe)`, e a spec carrega as
variantes no campo `variants` em vez de gerar três documentos que o triager vai
colapsar em um. `ctl.mjs findings` lista a hipótese; a spec é o operador que
escreve, já com `severity` e, quando for cadeia, com `chain`.

A spec boa tem fase `positive`, `attack`, `negative` e, quando declara
`attribution`, `confound` — o juiz só emite `proven` com positivo e negativo
válidos, e sem `confound` o achado não sobrevive ao gate. Spec já reprovada só
roda de novo quando o arquivo muda (a esteira carimba mtime).

## 5. Ler o estado

```bash
node bugbounty-ops/esteira/ctl.mjs list                        # todos os engajamentos
node bugbounty-ops/esteira/ctl.mjs status --target <slug>      # objetivo, candidatos, impedimento
node bugbounty-ops/esteira/ctl.mjs findings --target <slug>     # pauta: hipóteses abertas + endpoints com sinal
node bugbounty-ops/esteira/ctl.mjs report --target <slug>      # REPORT-<run>.md + reemite SUBMITS/
node bugbounty-ops/esteira/ctl.mjs submits --target <slug>     # INDEX: o que está novo vs submetido
node bugbounty-ops/esteira/ctl.mjs mark --target <slug> --id <id> --url <url>
```

O canal de reporte é arquivo, não conversa:

| arquivo | o que é |
|---|---|
| `engagements/<slug>/STATUS.md` | abre com o objetivo (ABERTO/ATINGIDO) e quantos submits já saíram |
| `engagements/<slug>/SUBMITS/INDEX.md` | um linha por achado: severidade, estado (`novo` / `submetido`), caminho |
| `engagements/<slug>/SUBMITS/<id>.md` | o rascunho daquele achado, escrito no `proven` |
| `engagements/<slug>/SUBMITS/<id>.submitted.json` | marca de envio (`mark`); tira o item da fila pendente |
| `engagements/<slug>/FINDINGS.md` | achados da tripulação que ainda não viraram spec |
| `engagements/<slug>/journal.jsonl` | append-only, todo evento, inclusive `submit` |
| `engagements/<slug>/IMPASSE.md` | **o canal de ação**: bloqueio atual, há quantos ciclos, o degrau de escalada e o que fazer agora |
| `surface/<slug>.json` | superfície + classificação de endpoint (real/catch-all/protegido) |

Ao responder "o que deu", leia `STATUS.md` e `SUBMITS/INDEX.md` e resuma em
poucas linhas: objetivo, quantos submits novos, melhor severidade comprovada,
impedimento atual. Achado que muda o plano (muralha, catch-all, endpoint aberto)
entra nesse resumo. Não cole o arquivo. O operador pode revisar o índice a qualquer momento.

## 5-bis. Impasse — o ciclo que não progride vira gatilho, não sono

O modo de falha mais caro desta esteira não é errar o alvo: é **ficar vivo e parado**.
Um engajamento real acumulou **192 ciclos `standby/sem-spec` idênticos** e executou o
engine **uma vez**. O processo respondia ao heartbeat, o `STATUS.md` era plausível, e
nada acontecia — porque `classify` devolvia o bloqueio e o ciclo apenas dormia.

O detector vive em `lib/impasse.mjs` e roda em **todo caminho que não executa spec**
(inclusive `spec-velha`, que é o caso mais comum). Ele faz três coisas:

**1. Conta ciclos por chave de bloqueio**, não por status. `standby:sem-spec` e
`standby:sem-contas` são impasses distintos; `error:engine exit 4` carrega o código
porque exit 4 é spec inválida, não falha de rede.

**2. Sobe degrau de escalada** com o tempo parado:

| ciclos | degrau | o que a ação manda fazer |
|---|---|---|
| 1–2 | `observar` | nada — primeiro ciclo não manda agir às cegas |
| 3–5 | `rota-metodo` | trocar verbo ou path antes de trocar a hipótese |
| 6–12 | `eixo` | trocar a pergunta: HTTP → browser → bundle → contrato → caso análogo |
| 13–24 | `evidencia` | remedir o próprio número, confrontar fontes, checar namespace e tamanho de amostra |
| 25+ | `escalar` | bloqueio nomeado + request completo colável para o operador |

**3. Escreve `IMPASSE.md`** com a ação específica do motivo. Genérico diz a direção
("troque de eixo"); específico diz o comando de hoje ("`ctl.mjs findings --target
<slug>` e escreva a próxima spec"). O específico vence enquanto o degrau está raso; em
degrau alto a escalada vence, porque insistir no mesmo diagnóstico já é o problema.

```bash
cat bugbounty-ops/esteira/engagements/<slug>/IMPASSE.md   # leia isto ao acordar o alvo
```

O journal **não** recebe uma linha por ciclo — recebe uma por mudança de degrau. Seis
ciclos parados produzem três linhas (`ciclos 1`, `3`, `6`), não seis. Journal que
cresce sem informação esconde o sinal.

Duas armadilhas já corrigidas, para não voltarem:

- **`attempted` em classificação.** Marcar `attempted: true` no ramo de `classify`
  inflava `attempts`, e alvo em `error` com `attempts >= 3` era **pulado para sempre**.
  Classificar não é tentar. Hoje um alvo em erro **volta a rodar quando existe spec não
  julgada** (mtime diferente) — spec corrigida sempre pode rodar.
- **`stall` não zerado no sucesso.** Spec executada é progresso: a contagem zera. Sem
  isso o alvo herdava 192 ciclos antigos e escalava ao degrau máximo no primeiro
  bloqueio novo.

Quando o degrau é `escalar`, a saída não é "preciso de acesso": é o request completo —
método, URL, headers e corpo sanitizados para revisão do operador. Enquanto isso o processo segue
vivo, e o engajamento **não** é encerrado por bloqueio de uma trilha.

## 6. Encerrar

```bash
node bugbounty-ops/esteira/ctl.mjs stop --target <slug>
```

`STOP` faz parar no próximo ponto seguro, nunca no meio de um request — diga
isso. Se houver request em voo e o operador quiser parada imediata, diga o que
está em voo em vez de fingir que parou.

O `stop` **não** encerra a missão: cada arquivo em `SUBMITS/` com estado `novo`
passa pelo gate humano `bug-bounty-pre-submission-gate`, um por vez, e depois
pela plataforma. `mark` registra o envio. Nada é publicado por esta esteira.

---

## O que NUNCA fazer

0. **Exija evidência validada para declarar impacto ou encerrar no piso.**
   Para auth-matrix, confirme o marcador do recurso protegido, o ataque sem
   credenciais e os controles. Para os demais oráculos, confirme o efeito
   declarado e os controles registrados. Evidência insuficiente deixa o
   rascunho em SEGURAR e o objetivo em aberto.

1. **Não criar goal nem laço de turnos para "manter vivo".** O processo mantém a
   si mesmo; goal consumiria modelo a noite toda e morreria com a sessão.
2. **Não rodar a varredura inline** quando o pedido é "deixa rodando". `once` só
   para inspeção explícita — e sempre com `--no-sweep --no-deepen` quando é só
   para ver o tabuleiro.
3. **Não reimplementar** classificação, fila ou varredura em cima da hora: muda-se
   `bugbounty-ops/esteira/` com teste (`node --test "bugbounty-ops/esteira/test/*.test.mjs"`).
4. **Não promover nada a `proven`** — só o juiz do `replay/v2` promove. Sem
   `severity` na spec, o candidato existe e o objetivo continua aberto.
5. **Não multiplicar alvo.** Engajamento é um alvo. Segundo alvo = segundo
   `ingest` + segundo `start`; nunca "só dou uma olhada" em outro programa no
   meio do ciclo.
6. **Não aceitar alvo sem anexo** nem escopo com mais de 7 dias: entram como
   bloqueio, não como suposição.

## Pré-voo antes de dizer "ligada"

```bash
node bugbounty-ops/esteira/ctl.mjs list        # já existe engajamento vivo nesse alvo?
ls bugbounty-ops/scopes/<plataforma>-<slug>/scope.json
```

Vivo: não reinicie, leia `status` e responda. Parado com estado em disco e o
operador querendo retomar: **não use `--fresh`** — o run retoma de onde parou.

## Falhas comuns

| sintoma | causa | ação |
|---|---|---|
| `ja rodando (pid N)` | instância viva | não duplique; leia `status` |
| `sem escopo anexado` (exit 2) | anexo não feito | `ingest` primeiro |
| `tem escopo mas nao tem campanha` (exit 3) | falta `campaigns/<slug>.json` | criar a partir do `_TEMPLATE.json` |
| processo morre logo após `start` | erro de sintaxe/import | `tail engagements/<slug>/esteira.log` |
| tudo em `escopo-vencido` | captura > 7 dias | recapturar com `bug-bounty-scope-first` |
| tudo em `sem-spec` | nenhuma `replay-*.json` | é o estado normal no começo: escrever spec |
| `surface` sem `deepen` | host morto ou só wildcard | wildcard exige descoberta de subdomínio |
| candidato `proven` e objetivo ABERTO | spec sem `severity` | declarar o tier (P1..P5) e rodar de novo |
| journal com dezenas de `classify` iguais | estado de antes do detector de impasse | ler `IMPASSE.md`, executar a ação do degrau |
| alvo mudo com `attempts` alto e `status: error` | `attempted` inflado por `classify` (corrigido) | gravar spec nova com mtime diferente; o alvo volta a rodar |
| `IMPASSE.md` preso em `observar` | bloqueio mudando de motivo a cada ciclo | normal: motivo novo zera a contagem — estabilize a classificação antes de escalar |
