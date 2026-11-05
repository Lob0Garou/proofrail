import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyGate, pickSignupLinks, bestGate, GATE_RANK, sameSite, siteOf } from '../lib/signup.mjs';

const page = (over = {}) => ({ status: 200, html: '', headers: {}, ...over });

test('Cloudflare 403 com cf-ray: botwall', () => {
  const r = classifyGate(page({
    status: 403,
    html: '<title>Attention Required! | Cloudflare</title>',
    headers: { 'cf-ray': '8a1b2c3d' },
  }));
  assert.equal(r.gate, 'botwall');
  assert.ok(r.evidence.length);
});

test('Akamai sapig com 200 nao e botwall: e sensor, deixa passar para o proximo portao', () => {
  const r = classifyGate(page({ html: '<script src="https://esp.sapig-prd.alvo.co.jp/x.js"></script><input type="email" name="email">' }));
  assert.equal(r.gate, 'email-only');
});

test('eKYC vence tudo: cadastro com documento de identidade', () => {
  const r = classifyGate(page({
    html: '<script src="https://js.trustdock-ekyc.com/v1/browser-sdk.js"></script><input type="email" name="email">',
  }));
  assert.equal(r.gate, 'ekyc');
  assert.match(r.evidence.join(' '), /Trustdock/);
});

test('campo telefone vira phone antes de email', () => {
  const r = classifyGate(page({ html: '<form><input type="email" name="email"><input type="tel" name="phone"></form>' }));
  assert.equal(r.gate, 'phone');
});

test('a string solta "phone" num bundle NAO vira phone (falso positivo medido)', () => {
  const bundle = 'function formatPhone(){var phone="+55";autocomplete:"tel"}var sms=1;';
  const r = classifyGate(page({ html: bundle, contentType: 'application/javascript', finalUrl: 'https://x/account/main.5f22.js' }));
  assert.equal(r.gate, 'desconhecido');
  assert.equal(r.hasForm, false);
});

test('SPA shell com <div id=root> e scripts nao e portal de cadastro', () => {
  const r = classifyGate(page({
    html: '<html><body><div id="root"></div><script src="/app/index.js"></script></body></html>',
    finalUrl: 'https://member.alvo.co.jp/register/example-account/email',
  }));
  assert.equal(r.gate, 'desconhecido');
  assert.equal(r.hasForm, false);
});

test('texto japones de telefone tambem conta', () => {
  const r = classifyGate(page({ html: '<form><label>電話番号</label><input type="text" name="denwa"></form>' }));
  assert.equal(r.gate, 'phone');
});

test('seletor de DDI conta como telefone', () => {
  const r = classifyGate(page({ html: '<form><select name="country_code"></select><input type="email" name="email"></form>' }));
  assert.equal(r.gate, 'phone');
});

test('campo SMS/OTP conta como telefone', () => {
  const r = classifyGate(page({ html: '<form><input type="email" name="email"><input name="sms_code"></form>' }));
  assert.equal(r.gate, 'phone');
});

test('captcha vem antes de email-only', () => {
  const r = classifyGate(page({ html: '<form><div class="g-recaptcha"></div><input type="email" name="email"></form>' }));
  assert.equal(r.gate, 'captcha');
});

test('pagina 200 sem formulario e desconhecido, nunca e-mail', () => {
  const r = classifyGate(page({ status: 200, html: '<div id="root"></div>' }));
  assert.equal(r.gate, 'desconhecido');
});

test('so e-mail: email-only (o caso que o operador quer)', () => {
  const r = classifyGate(page({ html: '<form><input type="email" name="email"><input type="password" name="pw"></form>' }));
  assert.equal(r.gate, 'email-only');
  assert.equal(r.hasForm, true);
});

test('usuario + senha tambem e email-only', () => {
  const r = classifyGate(page({ html: '<input type="text" name="username"><input type="password">' }));
  assert.equal(r.gate, 'email-only');
});

test('404 vira sem-cadastro', () => {
  assert.equal(classifyGate(page({ status: 404, html: 'not found' })).gate, 'sem-cadastro');
});

test('pagina 200 sem campo reconhecivel e desconhecido, nao e-mail', () => {
  const r = classifyGate(page({ status: 200, html: '<div id="root"></div>' }));
  assert.equal(r.gate, 'desconhecido');
});

test('precedencia declarada: email-only < captcha < desconhecido < phone < ekyc < botwall < sem-cadastro', () => {
  assert.ok(GATE_RANK['email-only'] < GATE_RANK.captcha);
  assert.ok(GATE_RANK.captcha < GATE_RANK.desconhecido);
  assert.ok(GATE_RANK.desconhecido < GATE_RANK.phone);
  assert.ok(GATE_RANK.phone < GATE_RANK.ekyc);
  assert.ok(GATE_RANK.ekyc < GATE_RANK.botwall);
  assert.ok(GATE_RANK.botwall < GATE_RANK['sem-cadastro']);
});

test('503 sem marcador de muralha e indisponivel, nao sem-cadastro', () => {
  assert.equal(classifyGate(page({ status: 503, html: 'Service Unavailable' })).gate, 'indisponivel');
});

test('sem-cadastro nao pode ganhar de desconhecido no bestGate', () => {
  const best = bestGate([{ gate: 'sem-cadastro', url: 'https://a/register' }, { gate: 'desconhecido', url: 'https://a/signup' }]);
  assert.equal(best.gate, 'desconhecido');
});

test('pickSignupLinks pega link de cadastro do proprio host e descarta terceiro', () => {
  const html = `
    <a href="/register/example-account/input/?nid=mm">会員登録</a>
    <a href="https://outro.com/signup">x</a>
    <a href="/produto/123">y</a>`;
  const links = pickSignupLinks(html, 'https://www.alvo.com/');
  assert.deepEqual(links, ['https://www.alvo.com/register/example-account/input/?nid=mm']);
});

test('link de cadastro em subdominio irmao e mantido', () => {
  const html = '<a href="//www.example.co.jp/register/example-account/input/?nid=mm">会員登録</a>';
  const links = pickSignupLinks(html, 'https://cart.example.co.jp/');
  assert.deepEqual(links, ['https://www.example.co.jp/register/example-account/input/?nid=mm']);
});

test('link para dominio de terceiro com "signup" no nome e descartado', () => {
  const links = pickSignupLinks('<a href="https://evil-site.com/signup">x</a>', 'https://alvo.co.jp/');
  assert.deepEqual(links, []);
});

test('mesmo site respeita TLD de duas partes (co.jp)', () => {
  assert.equal(sameSite('https://a.alvo.co.jp/', 'https://b.alvo.co.jp/'), true);
  assert.equal(sameSite('https://alvo.co.jp/', 'https://outro.co.jp/'), false);
  assert.equal(siteOf('https://member.example.co.jp/x'), 'example.co.jp');
  assert.equal(siteOf('https://api.portofantwerpbruges.com/x'), 'portofantwerpbruges.com');
});

test('bundle .js nunca entra como candidato a pagina de cadastro', () => {
  const links = pickSignupLinks('<link rel="modulepreload" href="/account/main.5f22.js">', 'https://alvo.com/');
  assert.deepEqual(links, []);
});

test('bestGate escolhe o portao mais permissivo encontrado', () => {
  const best = bestGate([
    { gate: 'botwall', url: 'https://a/register' },
    { gate: 'email-only', url: 'https://a/signup' },
    { gate: 'phone', url: 'https://a/join' },
  ]);
  assert.equal(best.gate, 'email-only');
  assert.equal(best.url, 'https://a/signup');
});

test('bestGate sem resultado devolve sem-cadastro', () => {
  assert.equal(bestGate([]).gate, 'sem-cadastro');
});
