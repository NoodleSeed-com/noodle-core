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
  function declared(defaultOrigin?: string) {
    const result = compile(
      manifest.replace(
        '  assistant:',
        `  variables:\n    - name: STORE_ORIGIN\n      schemaVersion: 1\n      valueSchema: { type: string, maxLength: 256 }\n      portal: { label: Website origin }\n      requiredFor: []\n${defaultOrigin ? `      default: ${defaultOrigin}\n` : ''}  assistant:`,
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.artifact;
  }

  it('decodes typed operator values and re-resolves the unchanged declaration', () => {
    const artifact = declared();
    const first = resolveManagedOrigins(artifact, { STORE_ORIGIN: '"https://first.example"' });
    const second = resolveManagedOrigins(artifact, { STORE_ORIGIN: '"https://second.example"' });
    expect(first.ok && first.artifact.server.assistant?.allowedOrigins).toEqual([
      'https://first.example',
    ]);
    expect(second.ok && second.artifact.server.assistant?.allowedOrigins).toEqual([
      'https://second.example',
    ]);
    expect(artifact.server.assistant?.allowedOrigins).toEqual(['${env.STORE_ORIGIN}']);
  });

  it('uses typed defaults and allows partial portal setup only when explicitly selected', () => {
    const withDefault = resolveManagedOrigins(declared('https://default.example'), {});
    expect(withDefault.ok && withDefault.artifact.server.assistant?.allowedOrigins).toEqual([
      'https://default.example',
    ]);
    const artifact = declared();
    expect(resolveManagedOrigins(artifact, {}).ok).toBe(false);
    const partial = resolveManagedOrigins(artifact, {}, { allowUnconfiguredPortal: true });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.artifact.server.assistant?.allowedOrigins).toEqual([]);
    expect(partial.artifact.server.assistant?.surfaces?.[0]?.origins).toEqual([]);
    expect(partial.artifact.server.handoff?.allowedDomains).toEqual([]);
    expect(JSON.stringify(partial.artifact.resources)).not.toContain('${env.STORE_ORIGIN}');
  });

  it('never makes invalid values or undeclared origins optional', () => {
    expect(
      resolveManagedOrigins(
        declared(),
        { STORE_ORIGIN: '"https://bad.example/path"' },
        { allowUnconfiguredPortal: true },
      ).ok,
    ).toBe(false);
    const result = compile(manifest);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(resolveManagedOrigins(result.artifact, {}, { allowUnconfiguredPortal: true }).ok).toBe(
      false,
    );
  });

  it('refuses operator settings that give two surfaces the same origin', () => {
    const artifact = declared();
    const assistant = artifact.server.assistant;
    if (!assistant) throw new Error('missing fixture assistant');
    const overlapping = {
      ...artifact,
      server: {
        ...artifact.server,
        assistant: {
          ...assistant,
          surfaces: [
            ...(assistant.surfaces ?? []),
            { mode: 'authenticated' as const, origins: ['https://same.example'] },
          ],
        },
      },
    };
    expect(resolveManagedOrigins(overlapping, { STORE_ORIGIN: '"https://same.example"' }).ok).toBe(
      false,
    );
  });

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
