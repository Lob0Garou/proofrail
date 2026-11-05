/** Compile the structured allowlist once for a sweep or deepening pass. */
export function scopePolicy({ assets = [], outOfScope = [] } = {}) {
  const compile = (entries) => entries.flatMap(({ asset, type }) => {
    if (type && /^(mobile|cidr|ip|texto|other|google_play_app_id|apple_store_app_id)$/i.test(type)) return [];
    const raw = String(asset ?? '').trim();
    const explicit = /^https?:\/\//i.test(raw);
    const wildcardHost = /^(?:https?:\/\/)?\*\./i.test(raw);
    const candidate = raw.replace(/^(https?:\/\/)?\*\./i, '$1');
    try {
      const prefix = candidate.endsWith('/*');
      const url = new URL((explicit ? '' : 'https://') + (prefix ? candidate.slice(0, -1) : candidate));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.href.includes('*') || url.hash || /%2f|%5c|%25/i.test(url.pathname)) return [];
      return [{ url, explicit, prefix, wildcardHost }];
    } catch { return []; }
  });
  const allowed = compile(assets);
  const denied = compile(outOfScope);
  const matches = (u, { url, explicit, prefix, wildcardHost }) =>
    (!explicit || u.protocol === url.protocol) &&
    (wildcardHost ? u.hostname.endsWith('.' + url.hostname) : u.hostname === url.hostname) &&
    u.port === url.port && (!url.search || url.search === u.search) &&
    (prefix ? u.pathname.startsWith(url.pathname) :
      !explicit && url.pathname === '/' ? true : u.pathname === url.pathname);
  return (value) => {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
        !/%2f|%5c|%25/i.test(u.pathname) &&
        allowed.some((r) => matches(u, r)) && !denied.some((r) => matches(u, r));
    } catch { return false; }
  };
}
