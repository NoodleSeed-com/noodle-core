import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import { compileManifest } from '../src/compile.js';

/**
 * A surface may declare that it never keeps chats (ADR 0241 decision 11). The manifest carries only the
 * literal `false`: a number of days is operator state (ADR 0212), so `true` or a count is refused rather
 * than read as a retention the business never chose.
 */
const catalog = new InMemoryCatalog([
  {
    id: 'acme',
    version: '1.0.0',
    operations: {
      look_up: {
        type: 'read',
        input: { type: 'object', properties: {}, additionalProperties: false },
        output: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  },
]);
const capabilities = [{ kind: 'tool', name: 'look_up' }];

function withSurface(surface: Record<string, unknown>): unknown {
  return {
    manifestVersion: '2',
    server: {
      name: 'acme_site',
      title: 'Acme Site',
      version: '1.0.0',
      assistant: {
        model: { kind: 'noodle-managed' },
        allowedOrigins: surface.kind === 'messaging' ? [] : ['https://www.acme.test'],
        surfaces: [surface],
      },
    },
    connectors: { acme: { id: 'acme', version: '1.0.0' } },
    tools: [
      {
        name: 'look_up',
        description: 'The look_up tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        fulfilment: { use: 'acme.look_up', args: {} },
      },
    ],
  };
}

const website = (mode: string, history?: unknown) => ({
  mode,
  origins: ['https://www.acme.test'],
  capabilities,
  ...(history === undefined ? {} : { history }),
});
const messaging = (history?: unknown) => ({
  kind: 'messaging',
  channel: 'whatsapp',
  mode: 'public',
  // The messaging profile cannot run a plain connector read, and the declaration is surface-level.
  capabilities: [],
  ...(history === undefined ? {} : { history }),
});

describe('a surface may declare history: false', () => {
  it('carries the declaration on website and messaging surfaces into the artifact', () => {
    for (const surface of [
      website('public', false),
      website('mixed', false),
      website('authenticated', false),
      messaging(false),
    ]) {
      const result = compileManifest(withSurface(surface), { catalog });
      expect(result.ok, JSON.stringify(result.ok ? [] : result.errors)).toBe(true);
      if (result.ok) expect(result.artifact.server.assistant?.surfaces?.[0]?.history).toBe(false);
    }
  });

  it('injects nothing when a surface stays silent', () => {
    const result = compileManifest(withSurface(website('public')), { catalog });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.server.assistant?.surfaces?.[0]).not.toHaveProperty('history');
    }
  });

  it('refuses true or a number of days on every surface kind', () => {
    for (const value of [true, 30, 0, 'off']) {
      for (const surface of [website('public', value), website('authenticated', value)]) {
        const result = compileManifest(withSurface(surface), { catalog });
        expect(result.ok, `expected history ${JSON.stringify(value)} to be refused`).toBe(false);
      }
      expect(compileManifest(withSurface(messaging(value)), { catalog }).ok).toBe(false);
    }
  });
});
