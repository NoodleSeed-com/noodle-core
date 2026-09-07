export const WIDGET_HANDOFF_SOURCE: string = `
  function trimmedUrl(value) {
    let out = String(value || '');
    while (out.length && out.charCodeAt(0) <= 32) out = out.slice(1);
    return out;
  }
  function allowedLink(value) {
    const url = trimmedUrl(value);
    if (!/^https?:\\/\\//i.test(url)) return { ok: false, reason: 'scheme' };
    const domains = cfg && cfg.handoff && Array.isArray(cfg.handoff.allowedDomains) ? cfg.handoff.allowedDomains : [];
    if (!domains.length) return { ok: true, url };
    try {
      const target = new URL(url);
      for (const domain of domains) {
        try {
          const allowed = new URL(String(domain));
          if (target.origin === allowed.origin) return { ok: true, url };
        } catch (e) {}
      }
      return { ok: false, reason: 'domain' };
    } catch (e) {
      return { ok: false, reason: 'url' };
    }
  }
  function resolveHandoffSession(raw, ctx) {
    if (!raw) return { ok: false, reason: 'missing' };
    const idx = String(raw).indexOf(':');
    if (idx <= 0) return { ok: false, reason: 'missing' };
    const source = String(raw).slice(0, idx);
    const path = String(raw).slice(idx + 1);
    const session = get((ctx && ctx[source]) || {}, path);
    if (!session || typeof session !== 'object') return { ok: false, reason: 'missing' };
    const url = typeof session.url === 'string' ? session.url : '';
    const purpose = typeof session.purpose === 'string' ? session.purpose : '';
    const expiresAt = typeof session.expiresAt === 'string' ? session.expiresAt : '';
    if (!url || !purpose || !expiresAt) return { ok: false, reason: 'missing' };
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) return { ok: false, reason: 'missing' };
    if (expiry <= Date.now()) return { ok: true, expired: true, url };
    return { ok: true, url };
  }
`;
