import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';
import type { Manifest } from '../src/manifest/schema.js';
import { testCatalog } from './catalog.js';

/** Connector declaration for the tests that reference `acme.get_order`. */
const ACME = { acme: { id: 'acme_orders', version: '1.2.0' } };

/** A manifest with one trivial (connector-free) tool plus whatever resources/prompts a test supplies. */
function manifest(extra: Partial<Manifest>): Manifest {
  return {
    manifestVersion: '1',
    server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
    tools: [
      {
        name: 'noop',
        description: 'A no-op tool.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [{ id: 'm', map: { v: 'ok' } }], output: { ok: '${steps.m.v}' } },
      },
    ],
    ...extra,
  } as Manifest;
}

describe('resource compilation', () => {
  it('emits a static (fixed-URI, steps-less) resource and advertises the capability', () => {
    const result = compileManifest(
      manifest({
        resources: [
          {
            name: 'changelog',
            uri: 'docs://changelog',
            mimeType: 'text/markdown',
            fulfilment: { steps: [], output: { value: '# Changelog' } },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resource = result.artifact.resources?.[0];
    expect(resource?.name).toBe('changelog');
    expect(resource?.isTemplate).toBe(false);
    expect(resource?.mimeType).toBe('text/markdown');
    expect(result.artifact.capabilities.resources).toEqual(['changelog']);
  });

  it('emits a templated resource with its variables', () => {
    const result = compileManifest(
      manifest({
        connectors: ACME,
        resources: [
          {
            name: 'order',
            uri: 'orders://{id}',
            fulfilment: {
              steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
              output: { value: '${steps.get.order}' },
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resource = result.artifact.resources?.[0];
    expect(resource?.isTemplate).toBe(true);
    expect(resource?.variables).toEqual(['id']);
  });

  it('emits resource metadata and a direct operation fulfilment', () => {
    const result = compileManifest(
      manifest({
        connectors: ACME,
        resources: [
          {
            name: 'order',
            uri: 'orders://{id}',
            title: 'Order',
            description: 'Order details.',
            mimeType: 'application/json',
            fulfilment: { use: 'acme.get_order', args: { id: '${input.id}' } },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resources?.[0]).toMatchObject({
      name: 'order',
      title: 'Order',
      description: 'Order details.',
      mimeType: 'application/json',
      fulfilment: { kind: 'operation' },
    });
  });

  it('a resource-only connector reference is not flagged as an unused alias', () => {
    // `acme` is referenced only by the resource, never by a tool — the alias-usage check must see it.
    const result = compileManifest(
      manifest({
        connectors: ACME,
        resources: [
          {
            name: 'order',
            uri: 'orders://{id}',
            fulfilment: {
              steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
              output: { value: '${steps.get.order}' },
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
  });

  it('a prompt-only connector reference is not flagged as an unused alias', () => {
    const result = compileManifest(
      manifest({
        connectors: ACME,
        prompts: [
          {
            name: 'summarize',
            arguments: [{ name: 'id', required: true }],
            fulfilment: {
              steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
              output: { value: 'Order ${steps.get.order.status}' },
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate resource names, duplicate URIs, and unsupported templates', () => {
    const dupName = compileManifest(
      manifest({
        resources: [
          { name: 'r', uri: 'a://1', fulfilment: { steps: [], output: { value: 'x' } } },
          { name: 'r', uri: 'a://2', fulfilment: { steps: [], output: { value: 'y' } } },
        ],
      }),
    );
    expect(dupName.ok).toBe(false);
    if (!dupName.ok) expect(dupName.errors.some((e) => e.code === 'duplicate_resource')).toBe(true);

    const dupUri = compileManifest(
      manifest({
        resources: [
          { name: 'r1', uri: 'a://same', fulfilment: { steps: [], output: { value: 'x' } } },
          { name: 'r2', uri: 'a://same', fulfilment: { steps: [], output: { value: 'y' } } },
        ],
      }),
    );
    expect(dupUri.ok).toBe(false);
    if (!dupUri.ok)
      expect(dupUri.errors.some((e) => e.code === 'duplicate_resource_uri')).toBe(true);

    const badTemplate = compileManifest(
      manifest({
        resources: [
          { name: 'r', uri: 'a://{+oops}', fulfilment: { steps: [], output: { value: 'x' } } },
        ],
      }),
    );
    expect(badTemplate.ok).toBe(false);
    if (!badTemplate.ok)
      expect(badTemplate.errors.some((e) => e.code === 'unsupported_uri_template')).toBe(true);
  });
});

describe('prompt compilation', () => {
  it('emits a prompt with its argument descriptors and advertises the capability', () => {
    const result = compileManifest(
      manifest({
        prompts: [
          {
            name: 'triage',
            description: 'Triage a ticket.',
            arguments: [{ name: 'id', description: 'ticket id', required: true }],
            fulfilment: { steps: [], output: { value: 'Triage ${input.id}' } },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompt = result.artifact.prompts?.[0];
    expect(prompt?.name).toBe('triage');
    expect(prompt?.arguments).toEqual([{ name: 'id', description: 'ticket id', required: true }]);
    expect(result.artifact.capabilities.prompts).toEqual(['triage']);
  });

  it('emits prompt metadata and a direct operation fulfilment', () => {
    const result = compileManifest(
      manifest({
        connectors: ACME,
        prompts: [
          {
            name: 'summarize',
            title: 'Summarize',
            description: 'Summarize an order.',
            arguments: [{ name: 'id', required: true }],
            fulfilment: { use: 'acme.get_order', args: { id: '${input.id}' } },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.prompts?.[0]).toMatchObject({
      name: 'summarize',
      title: 'Summarize',
      description: 'Summarize an order.',
      arguments: [{ name: 'id', required: true }],
      fulfilment: { kind: 'operation' },
    });
  });

  it('rejects duplicate prompt names', () => {
    const result = compileManifest(
      manifest({
        prompts: [
          { name: 'p', fulfilment: { steps: [], output: { value: 'a' } } },
          { name: 'p', fulfilment: { steps: [], output: { value: 'b' } } },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.code === 'duplicate_prompt')).toBe(true);
  });
});

describe('tools-only artifact is unchanged', () => {
  it('compiles a pure connector-free tool as a steps-less flow', () => {
    const result = compileManifest(
      manifest({
        tools: [
          {
            name: 'echo',
            description: 'Echo input.',
            inputSchema: { type: 'object' },
            fulfilment: { steps: [], output: { id: '${input.id}' } },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.fulfilment).toMatchObject({
      kind: 'flow',
      steps: [],
    });
  });

  it('omits resources/prompts keys entirely when none are declared', () => {
    const result = compileManifest(manifest({}), { catalog: testCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('resources' in result.artifact).toBe(false);
    expect('prompts' in result.artifact).toBe(false);
    expect('resources' in result.artifact.capabilities).toBe(false);
  });
});

describe('flow fulfilment validation', () => {
  it('still rejects resources and prompts whose flow has no output', () => {
    const resourceResult = compileManifest(
      manifest({
        resources: [
          {
            name: 'r',
            uri: 'docs://r',
            fulfilment: { steps: [] },
          } as NonNullable<Manifest['resources']>[number],
        ],
      }),
    );
    expect(resourceResult.ok).toBe(false);
    if (!resourceResult.ok) {
      expect(resourceResult.errors.some((e) => e.path === 'resources.0.fulfilment.output')).toBe(
        true,
      );
    }

    const promptResult = compileManifest(
      manifest({
        prompts: [
          {
            name: 'p',
            fulfilment: { steps: [] },
          } as NonNullable<Manifest['prompts']>[number],
        ],
      }),
    );
    expect(promptResult.ok).toBe(false);
    if (!promptResult.ok) {
      expect(promptResult.errors.some((e) => e.path === 'prompts.0.fulfilment.output')).toBe(true);
    }
  });
});
