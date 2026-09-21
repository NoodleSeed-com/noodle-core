import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import { compileManifest } from '../src/compile.js';

const surface = {
  kind: 'messaging',
  channel: 'whatsapp',
  mode: 'public',
  capabilities: [{ kind: 'tool', name: 'health' }],
};
function manifest(messaging: object = surface, readOnlyHint = true) {
  return {
    manifestVersion: '1',
    server: {
      name: 'messaging',
      version: '1.0.0',
      title: 'Messaging',
      assistant: { model: { kind: 'noodle-managed' }, allowedOrigins: [], surfaces: [messaging] },
    },
    tools: [
      {
        name: 'health',
        description: 'Read service information.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  };
}
const catalog = new InMemoryCatalog([]);

describe('compiled messaging projection', () => {
  it('compiles a messaging-only assistant without browser origins', () => {
    expect(compileManifest(manifest(), catalog).ok).toBe(true);
  });
  it('rejects forged browser fields and missing capabilities', () => {
    expect(
      compileManifest(manifest({ ...surface, origins: ['https://acme.test'] }), catalog).ok,
    ).toBe(false);
    expect(
      compileManifest(manifest({ kind: 'messaging', channel: 'whatsapp', mode: 'public' }), catalog)
        .ok,
    ).toBe(false);
  });
  it('rejects writes on the read-only messaging surface', () => {
    const result = compileManifest(manifest(surface, false), catalog);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.code === 'channel_requirement_unsupported')).toBe(
        true,
      );
  });
});
