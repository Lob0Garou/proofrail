// Classificador de portao de cadastro. Responde a pergunta que decide se um
// alvo e' atacavel sozinho: o que o alvo exige ANTES de deixar alguem entrar?
//
// Leitura apenas: GET na pagina de cadastro. Nenhum POST, nenhuma conta criada.

// Ordem = "quao bom para mim". Nao e' severidade do portao, e' utilidade.
// desconhecido vem antes de phone porque SPA pode renderizar form so-e-mail
// via JS e merece inspecao; sem-cadastro e' beco sem saida; indisponivel e' pior.
export const GATE_RANK = {
  'email-only': 0,
  captcha: 1,
  desconhecido: 2,
  phone: 3,
  ekyc: 4,
  botwall: 5,
  'sem-cadastro': 6,
  indisponivel: 7,
  'sem-superficie': 8,
};

const BOTWALL = [
  ['Attention Required! | Cloudflare', 'aviso de bloqueio Cloudflare'],
  ['cf-browser-verification', 'script de desafio Cloudflare'],
  ['sapig', 'sensor Akamai Bot Manager'],
  ['datadome', 'DataDome'],
  ['_Incapsula_Resource', 'Imperva Incapsula'],
  ['px-captcha', 'PerimeterX'],
  ['Just a moment', 'intersticial Cloudflare'],
];

const EKYC = [
  ['trustdock', 'Trustdock eKYC'],
  ['onfido', 'Onfido'],
  ['jumio', 'Jumio'],
  ['sumsub', 'Sumsub'],
  ['veriff', 'Veriff'],
  ['withpersona', 'Persona'],
  ['本人確認', 'verificacao de identidade (JP)'],
];

const CAPTCHA = [
  ['g-recaptcha', 'reCAPTCHA'],
  ['hcaptcha', 'hCaptcha'],
  ['cf-turnstile', 'Turnstile'],
  ['arkoselabs', 'Arkose'],
  ['funcaptcha', 'FunCaptcha'],
];

// Telefone exige contexto de CAMPO. A string solta "phone" aparece em qualquer
// bundle JS (autocomplete, lib de mascara) e transformava todo SPA em "phone".
const PHONE_PATTERNS = [
  [/\btype\s*=\s*["']?tel\b/i, 'input type=tel'],
  [/<input[^>]+(?:name|id)\s*=\s*["'][^"']*(?:phone|telefone|telefon|mobile|cellphone|msisdn)[^"']*["']/i, 'campo telefone'],
  [/<select[^>]+(?:name|id)\s*=\s*["'][^"']*(?:phone|country.?code|dial.?code)[^"']*["']/i, 'seletor de DDI'],
  [/電話番号/, 'texto "telefone" (JP)'],
  [/<(?:input|label)[^>]*[^>]*?(?:sms|otp)[-_ ]?(?:code|token|verify|verification)/i, 'campo SMS/OTP'],
  [/ワンタイムパスワード/, 'senha de uso unico (JP)'],
];

const EMAIL_PATTERNS = [
  [/\btype\s*=\s*["']?email\b/i, 'input type=email'],
  [/<input[^>]+(?:name|id)\s*=\s*["'][^"']*(?:e-?mail|mail)[^"']*["']/i, 'campo e-mail'],
  [/<input[^>]+type\s*=\s*["']text["'][^>]+name\s*=\s*["']username/i, 'campo usuario+senha'],
];

const PAGE_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|json)(\?|$)/i;

/** Uma pagina de cadastro precisa ter formulario. SPA shell vazia nao e' portal. */
export function looksLikeFormPage(html) {
  return /<form[\s>]/i.test(html) || /<input[\s>]/i.test(html);
}

/** Bundle JS/CSS servido no lugar da pagina nao e' pagina de cadastro. */
export function looksLikeAsset(page) {
  const ct = String(page.contentType || page.headers?.['content-type'] || '').toLowerCase();
  if (/javascript|text\/css|image\/|font\//.test(ct)) return true;
  return PAGE_EXT.test(String(page.finalUrl || page.url || ''));
}

function hits(html, list) {
  const low = html.toLowerCase();
  return list.filter(([needle]) => low.includes(needle.toLowerCase())).map(([, label]) => label);
}

function patternHits(html, list) {
  return list.filter(([re]) => re.test(html)).map(([, label]) => label);
}

/**
 * @param {{status:number, html:string, headers?:Record<string,string>, finalUrl?:string}} page
 * @returns {{gate:string, evidence:string[], hasForm:boolean}}
 */
export function classifyGate(page) {
  const html = String(page.html || '');
  const headers = page.headers || {};
  const status = Number(page.status || 0);
  const evidence = [];

  // 0. asset servido no lugar da pagina, ou pagina sem formulario: nao ha portao
  //    para ler. Antes de olhar qualquer string, provar que existe um formulario.
  if (looksLikeAsset(page)) {
    return { gate: 'desconhecido', evidence: ['resposta nao e pagina de cadastro (asset)'], hasForm: false };
  }

  // 1. muralha anti-bot: nao ha formulario para ler, a porta ja barrou
  const cfRay = headers['cf-ray'] || headers['CF-RAY'];
  if (status === 403 || status === 503) {
    const bw = hits(html, BOTWALL);
    if (bw.length || cfRay) {
      return { gate: 'botwall', evidence: [...bw, cfRay ? 'cf-ray presente' : ''].filter(Boolean), hasForm: false };
    }
  }
  const bwAny = hits(html, BOTWALL);
  if (bwAny.length && status >= 400) return { gate: 'botwall', evidence: bwAny, hasForm: false };

  if (status >= 500) return { gate: 'indisponivel', evidence: [`HTTP ${status} sem marcador de muralha`], hasForm: false };
  if (status >= 400) return { gate: 'sem-cadastro', evidence: [`HTTP ${status}`], hasForm: false };

  // 2. daqui para baixo so vale se houver formulario. SPA shell de <div id="root">
  //    mais um monte de <script> nao diz nada sobre o cadastro.
  if (!looksLikeFormPage(html)) {
    return { gate: 'desconhecido', evidence: ['pagina sem formulario (SPA ou conteudo estatico)'], hasForm: false };
  }

  // 3. eKYC: exige documento de identidade — capacidade fisica, nao decisao
  const ek = hits(html, EKYC);
  if (ek.length) return { gate: 'ekyc', evidence: ek, hasForm: true };

  // 4. telefone/SMS — so conta se for campo, nunca a string solta
  const ph = patternHits(html, PHONE_PATTERNS);
  if (ph.length) return { gate: 'phone', evidence: ph, hasForm: true };

  // 5. captcha
  const cp = hits(html, CAPTCHA);
  if (cp.length) return { gate: 'captcha', evidence: cp, hasForm: true };

  // 6. so e-mail
  const em = patternHits(html, EMAIL_PATTERNS);
  if (em.length) return { gate: 'email-only', evidence: em, hasForm: true };

  return { gate: 'desconhecido', evidence: ['formulario sem campo reconhecivel'], hasForm: true };
}

const LINK_RE = /href="([^"]+)"/gi;
const LINK_KIND = /(register|signup|sign-up|sign_up|join|enroll|create[-_]?account|new[-_]?account|apply|member|account)/i;

// Cadastro mora em host dedicado (member., accounts., id., login.), nao no host
// da home. Mesmo SITE (eTLD+1), hosts diferentes. Restringir a mesma origem
// descartava justamente o link que importa.
const TWO_PART_TLD = /\.(co|com|org|net|gov|ac|edu|or|ne|go|mil)\.[a-z]{2}$/i;

/** eTLD+1 aproximado: "member.example.co.jp" -> "example.co.jp". */
export function siteOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_TLD.test('.' + last2) ? parts.slice(-3).join('.') : last2;
}

export function sameSite(a, b) {
  try { return siteOf(a) === siteOf(b); } catch { return false; }
}

/** Extrai candidatos a pagina de cadastro do HTML da home, como URL absoluta. */
export function pickSignupLinks(html, baseUrl, limit = 4) {
  const out = new Set();
  for (const m of String(html || '').matchAll(LINK_RE)) {
    const href = m[1];
    if (!LINK_KIND.test(href)) continue;
    if (PAGE_EXT.test(href)) continue;              // <link rel=modulepreload href=...js> nao e' pagina
    try {
      const u = new URL(href, baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (!sameSite(u.href, baseUrl)) continue;     // outro dominio: fora
      out.add(u.href);
    } catch { /* href invalido */ }
    if (out.size >= limit) break;
  }
  return [...out];
}

// Ordem importa: os primeiros sao as convencoes reais. `/users/sign_up` e' o
// caminho do Rails/Discourse/GitLab — sem ele o GitLab inteiro passava batido.
export const SIGNUP_PATHS = [
  '/users/sign_up',        // Rails/devise (GitLab, Discourse)
  '/users/register',
  '/register',
  '/signup',
  '/sign-up',
  '/registration',
  '/join',
  '/create-account',
  '/account/register',
  '/auth/register',
  '/enroll',
];

/** Pega o portao mais permissivo encontrado — e' ele que decide a entrada. */
export function bestGate(results) {
  if (!results || !results.length) return { gate: 'sem-cadastro', evidence: ['nenhuma pagina de cadastro respondeu'], hasForm: false, url: null };
  const sorted = [...results].sort((a, b) => (GATE_RANK[a.gate] ?? 9) - (GATE_RANK[b.gate] ?? 9));
  return sorted[0];
}
