// Build-time replacement for the SDK's SHA-256-only Node import. Runs inside QuickJS.
// It uses the existing bounded, deterministic digest helper, never Node or Web Crypto.
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error('Unsupported authoring digest');
  let text = '';
  return {
    update(value: string, encoding = 'utf8') {
      if (typeof value !== 'string' || encoding !== 'utf8')
        throw new Error('Invalid authoring digest input');
      text += value;
      if (text.length > 8192) throw new Error('Authoring digest input exceeds 8192 characters');
      return this;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') throw new Error('Unsupported authoring digest encoding');
      const helper = (
        globalThis as unknown as { __explicitHelper: (name: string, args: string) => string }
      ).__explicitHelper;
      const result = JSON.parse(helper('digest', JSON.stringify([text, 'hex']))) as {
        ok: boolean;
        value?: string;
      };
      if (!result.ok || typeof result.value !== 'string')
        throw new Error('Authoring digest unavailable');
      return result.value;
    },
  };
}
