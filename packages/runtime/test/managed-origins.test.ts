import { compile } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { resolveManagedOrigins } from '../src/index.js';

const manifest = `
manifestVersion: "2"
server:
  name: managed_store
  version: 1.0.0
  title: Managed store
  assistant:
    model: { kind: openai-compatible, baseUrl: "\${env.MODEL_URL}", model: "\${env.MODEL}", apiKey: MODEL_KEY }
    allowedOrigins: ["\${env.STORE_ORIGIN}"]
    surfaces:
      - mode: public
        origins: ["\${env.STORE_ORIGIN}"]
        capabilities: [{ kind: tool, name: browse }]
handoff:
  allowedDomains: ["\${env.STORE_ORIGIN}"]
tools:
  - name: browse
    description: Browse products.
    annotations: { readOnlyHint: true }
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { status: ok } }
widgets:
  - name: catalog
    tool: browse
    html: '<main>Catalog</main>'
`;

describe('managed exact origins', () => {
  it('compiles reusable intent and resolves every runtime authority projection', () => {
    const compiled = compile(manifest);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.config?.variables).toContain('STORE_ORIGIN');

    const resolved = resolveManagedOrigins(compiled.artifact, {
      STORE_ORIGIN: 'https://merchant.myshopify.com',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.artifact.server.assistant?.allowedOrigins).toEqual([
      'https://merchant.myshopify.com',
    ]);
    expect(resolved.artifact.server.assistant?.surfaces?.[0]?.origins).toEqual([
      'https://merchant.myshopify.com',
    ]);
    expect(resolved.artifact.server.handoff?.allowedDomains).toEqual([
      'https://merchant.myshopify.com',
    ]);
    const resource = resolved.artifact.resources?.[0];
    expect(resource?._meta?.['openai/widgetCSP']).toMatchObject({
      redirect_domains: ['https://merchant.myshopify.com'],
    });
    expect(JSON.stringify(resource)).not.toContain('${env.STORE_ORIGIN}');
  });

  it.each([
    ['missing', undefined],
    ['non-HTTPS', 'http://merchant.example.com'],
    ['non-canonical', 'https://merchant.example.com/catalog'],
    ['credentials', 'https://user:pass@merchant.example.com'],
  ])('rejects a %s managed production origin', (_label, origin) => {
    const compiled = compile(manifest);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const resolved = resolveManagedOrigins(
      compiled.artifact,
      origin === undefined ? {} : { STORE_ORIGIN: origin },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.errors).toEqual([
      expect.objectContaining({
        variableName: 'STORE_ORIGIN',
        reason: origin === undefined ? 'missing' : 'invalid',
      }),
      expect.objectContaining({
        variableName: 'STORE_ORIGIN',
        reason: origin === undefined ? 'missing' : 'invalid',
      }),
      expect.objectContaining({
        variableName: 'STORE_ORIGIN',
        reason: origin === undefined ? 'missing' : 'invalid',
      }),
    ]);
    expect(resolved).not.toHaveProperty('artifact');
    if (origin !== undefined) expect(JSON.stringify(resolved)).not.toContain(origin);
  });
});
