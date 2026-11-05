# ProofRail para DSH

A esteira acompanha um escopo por engajamento, mantém a fila local e prepara rascunhos a partir de evidências verificadas. A execução de hipóteses usa um replayer compatível com o contrato replay/v2.

## Instalação

1. Use Node.js 22.16 ou superior. Execute os comandos na raiz deste pacote.
2. Copie `skills/proofrail` para o diretório de skills do seu perfil DSH. Use este pacote como diretório de trabalho.
3. Configure `ESTEIRA_REPLAYER_DIR` com o caminho absoluto de uma instalação confiável e compatível do Strix-Benchmark. O padrão é `./replayer`. A instalação deve fornecer `scripts/replay.mjs`, campanhas e as fixtures exigidas pelo replayer. O replayer ainda não está disponível neste repositório e não há link público de instalação confirmado.
4. Prepare `scope.json` com o escopo estruturado atual, incluindo exclusões estruturadas. Confira as restrições textuais e a política de automação antes de preparar a campanha. O escopo de captura pode ser produzido por uma ferramenta independente.

```text
node bugbounty-ops/esteira/ctl.mjs ingest PATH_TO_SCOPE_JSON
node bugbounty-ops/esteira/ctl.mjs start --target PROGRAM_SLUG --min-severity P3 --stop-at-p3
node bugbounty-ops/esteira/ctl.mjs status --target PROGRAM_SLUG
node bugbounty-ops/esteira/ctl.mjs stop --target PROGRAM_SLUG
node --test "bugbounty-ops/esteira/test/*.test.mjs"
```

`ingest` aceita o JSON, sua pasta ou um `SCOPE.md` com o JSON ao lado. A suite usa fixtures sintéticas. `examples/scope.example.json` é um exemplo de formato com data propositalmente vencida.

A camada de escopo compara protocolo, host, porta e caminho. A varredura confere cada redirecionamento antes de seguir. A proteção do subprocesso cobre o transporte Fetch do replayer compatível. Use somente replayers confiáveis que mantenham todo o tráfego HTTP nesse transporte. A CLI nunca envia um rascunho à plataforma.

Uma execução completa foi verificada no Windows com uma cópia local do replayer, uma campanha fictícia e um servidor em loopback. A verificação cobriu ingestão, execução de uma spec, leitura do resultado e geração do rascunho. A instalação independente por terceiros continua pendente da distribuição do replayer.

O ProofRail está disponível sob a [licença MIT](LICENSE). A licença do replayer distribuído separadamente deve ser verificada junto à sua fonte.
