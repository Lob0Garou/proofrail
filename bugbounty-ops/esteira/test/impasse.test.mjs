// Testes do detector de impasse.
//
// O caso que estes testes travam: 192 ciclos `standby/sem-spec` identicos, com o
// engine rodando UMA vez. O detector tem que (a) contar ciclos sem inventar
// mudanca, (b) zerar a contagem quando o bloqueio muda de verdade, (c) subir
// degrau de escalada, e (d) nao transformar o journal em 192 linhas iguais.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  impasseKey, degrauPara, detectarImpasse, deveRegistrar, renderImpasse,
  motivoDe, DEGRAUS, ACAO_POR_MOTIVO,
} from '../lib/impasse.mjs';

test('chave distingue motivo, nao so status', () => {
  assert.equal(impasseKey({ status: 'standby', reason: 'sem-spec' }), 'standby:sem-spec');
  assert.notEqual(
    impasseKey({ status: 'standby', reason: 'sem-spec' }),
    impasseKey({ status: 'standby', reason: 'sem-contas' }),
  );
  // error carrega o motivo, que carrega o codigo de saida
  assert.equal(impasseKey({ status: 'error', reason: 'engine exit 4' }), 'error:engine exit 4');
  assert.equal(impasseKey({}), 'unknown:sem-razao');
});

test('motivoDe remove o prefixo de status', () => {
  assert.equal(motivoDe('standby:sem-spec'), 'sem-spec');
  assert.equal(motivoDe('sem-spec'), 'sem-spec');
});

test('degrau sobe com o numero de ciclos e nao regride', () => {
  assert.equal(degrauPara(1).id, 'observar');
  assert.equal(degrauPara(3).id, 'rota-metodo');
  assert.equal(degrauPara(8).id, 'eixo');
  assert.equal(degrauPara(20).id, 'evidencia');
  assert.equal(degrauPara(1000).id, 'escalar');
  let anterior = -1;
  for (const n of [1, 2, 3, 5, 6, 12, 13, 24, 25, 999]) {
    const idx = DEGRAUS.indexOf(degrauPara(n));
    assert.ok(idx >= anterior, `degrau regrediu em ${n}`);
    anterior = idx;
  }
});

test('primeiro ciclo observa; segundo com mesmo bloqueio ja escala', () => {
  const c1 = detectarImpasse(null, { status: 'standby', reason: 'sem-spec' });
  assert.equal(c1.ciclos, 1);
  assert.equal(c1.degrau.id, 'observar');
  assert.equal(c1.acao, null, 'primeiro ciclo nao deve mandar agir as cegas');
  assert.equal(c1.novo, true);

  const c2 = detectarImpasse({ key: c1.key, ciclos: 1 }, { status: 'standby', reason: 'sem-spec' });
  assert.equal(c2.ciclos, 2);
  assert.equal(c2.mudou, false);
  assert.equal(c2.novo, false);
});

test('bloqueio que muda zera a contagem', () => {
  const travado = { key: 'standby:sem-spec', ciclos: 40 };
  const outro = detectarImpasse(travado, { status: 'standby', reason: 'sem-contas' });
  assert.equal(outro.ciclos, 1, 'motivo novo e um impasse novo');
  assert.equal(outro.mudou, true);
  assert.equal(outro.key, 'standby:sem-contas');
});

test('a acao do motivo vence a generica enquanto o degrau esta raso', () => {
  const s = detectarImpasse({ key: 'standby:sem-spec', ciclos: 3 }, { status: 'standby', reason: 'sem-spec' });
  assert.equal(s.acao, ACAO_POR_MOTIVO['sem-spec']);
  assert.match(s.acao, /findings --target/);

  const b = detectarImpasse({ key: 'standby:sem-contas', ciclos: 4 }, { status: 'standby', reason: 'sem-contas' });
  assert.match(b.acao, /segunda identidade/);
});

test('em degrau alto a escalada vence o motivo', () => {
  const s = detectarImpasse({ key: 'standby:sem-spec', ciclos: 30 }, { status: 'standby', reason: 'sem-spec' });
  assert.equal(s.degrau.id, 'escalar');
  assert.match(s.acao, /snippet|colavel/i);
});

test('motivo sem acao especifica cai no degrau', () => {
  const s = detectarImpasse({ key: 'error:engine exit 4', ciclos: 6 }, { status: 'error', reason: 'engine exit 4' });
  assert.equal(s.acao, degrauPara(7).acao);
  assert.ok(s.acao.length > 20);
});

test('journal nao recebe 192 linhas iguais', () => {
  // mesmo bloqueio, mesmo degrau -> silencio
  assert.equal(deveRegistrar({ key: 'standby:sem-spec', ciclos: 3 }, { key: 'standby:sem-spec', ciclos: 4, degrau: degrauPara(4) }), false);
  // chave nova -> registra
  assert.equal(deveRegistrar({ key: 'standby:sem-spec', ciclos: 3 }, { key: 'standby:sem-contas', ciclos: 1, degrau: degrauPara(1) }), true);
  // subiu de degrau -> registra
  assert.equal(deveRegistrar({ key: 'standby:sem-spec', ciclos: 2 }, { key: 'standby:sem-spec', ciclos: 3, degrau: degrauPara(3) }), true);
  // sem anterior -> registra
  assert.equal(deveRegistrar(null, { key: 'x:y', ciclos: 1, degrau: degrauPara(1) }), true);
});

test('render carrega a acao, o degrau e a doutrina P3/P4', () => {
  const stall = detectarImpasse({ key: 'standby:sem-spec', ciclos: 5 }, { status: 'standby', reason: 'sem-spec' });
  const md = renderImpasse({ slug: 'example-program', stall, cls: { status: 'standby', reason: 'sem-spec' }, min: 'P3' });
  assert.match(md, /# IMPASSE — example-program/);
  assert.match(md, /6 ciclo\(s\)/);
  assert.match(md, /standby:sem-spec/);
  assert.match(md, /findings --target/);
  assert.match(md, /P3 e P4 s[ãa]o dinheiro/);
  assert.match(md, /Impasse nao e estado terminal/);
});

test('render no primeiro ciclo nao inventa acao', () => {
  const stall = detectarImpasse(null, { status: 'standby', reason: 'sem-spec' });
  const md = renderImpasse({ slug: 'x', stall, cls: { status: 'standby' } });
  assert.match(md, /Nenhuma ainda/);
});
