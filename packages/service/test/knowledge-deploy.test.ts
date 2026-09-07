import { createHash } from 'node:crypto';
import {
  defaultKnowledgeStores,
  type KnowledgeServiceStores,
  wireKnowledge,
} from '@noodle-borg/knowledge-operations';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryConfigStore, ServerRegistry } from '../src/index.js';

/**
 * Deploy-coupled knowledge publication through the real registry deploy transaction
 * (ADR 0202): ordinary deploy stages/verifies/activates the revision with the artifact,
 * rollback restores the paired revision, and the gate fails a knowledge deploy closed.
 */

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const deployOptions = {
  accessMode: 'owner-only',
  actor: { subject: 'test-sub', email: 'dev@acme.test' },
} as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function knowledgeManifest(documents: Record<string, string>): string {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'acme_site',
      title: 'Acme Site',
      version: '1.0.0',
      knowledge: [
        {
          name: 'product',
          title: 'Product knowledge',
          description: 'Public product information.',
          documents: Object.entries(documents).map(([path, text]) => ({
            path,
            title: path,
            sha256: sha(text),
            bytes: Buffer.byteLength(text),
          })),
          sites: [],
        },
      ],
    },
    tools: [
      {
        name: 'ping',
        description: 'Ping.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}

let registry: ServerRegistry;
let configStore: InMemoryConfigStore;
let stores: KnowledgeServiceStores;

async function stage(documents: Record<string, string>): Promise<void> {
  for (const text of Object.values(documents)) {
    await stores.staging.put(
      `${tenant.org}/${tenant.app}/${tenant.env}`,
      sha(text),
      Buffer.from(text),
      Buffer.byteLength(text),
    );
  }
}

async function enableKnowledge(): Promise<void> {
  await configStore.setConfigValue({
    kind: 'variable',
    scope: { level: 'env', org: tenant.org, app: tenant.app, env: tenant.env },
    name: 'NOODLE_KNOWLEDGE_ENABLED',
    value: 'true',
  });
}

beforeEach(() => {
  configStore = new InMemoryConfigStore();
  registry = new ServerRegistry(undefined, undefined, configStore);
  stores = defaultKnowledgeStores();
  wireKnowledge(
    registry,
    stores,
    (ref) =>
      configStore.resolveConfigValues('variable', {
        level: 'env',
        org: ref.org,
        app: ref.app,
        env: ref.env,
      }),
    1024 * 1024,
  );
});

describe('knowledge deploy transaction', () => {
  it('publishes and activates the revision with an ordinary deploy, then rolls back paired', async () => {
    await enableKnowledge();
    const v1 = { 'docs/product.md': 'first version of the product knowledge' };
    await stage(v1);
    const first = await registry.deploy(tenant, knowledgeManifest(v1), deployOptions);
    expect(first.ok).toBe(true);
    const firstActive = await stores.revisionStore.active(tenant, 'product');
    expect(firstActive).toBeDefined();

    const v2 = { 'docs/product.md': 'second version, fully revised' };
    await stage(v2);
    const second = await registry.deploy(tenant, knowledgeManifest(v2), deployOptions);
    expect(second.ok).toBe(true);
    const secondActive = await stores.revisionStore.active(tenant, 'product');
    expect(secondActive?.revisionId).not.toBe(firstActive?.revisionId);

    if (!first.ok) return;
    const rollback = await registry.rollback(tenant, first.deploymentId);
    expect(rollback.ok).toBe(true);
    expect((await stores.revisionStore.active(tenant, 'product'))?.revisionId).toBe(
      firstActive?.revisionId,
    );
  });

  it('fails a knowledge deploy closed when the gate is off, retaining nothing', async () => {
    const documents = { 'docs/product.md': 'gated content' };
    await stage(documents);
    const result = await registry.deploy(tenant, knowledgeManifest(documents), deployOptions);
    expect(result.ok).toBe(false);
    if (result.ok || !('errors' in result)) return;
    expect(result.errors?.[0]).toMatchObject({ code: 'knowledge_not_enabled' });
    expect(await stores.revisionStore.active(tenant, 'product')).toBeUndefined();
  });

  it('fails with an idempotent-retry error when staged bytes are missing', async () => {
    await enableKnowledge();
    const result = await registry.deploy(
      tenant,
      knowledgeManifest({ 'docs/product.md': 'bytes never uploaded' }),
      deployOptions,
    );
    expect(result.ok).toBe(false);
    if (result.ok || !('errors' in result)) return;
    expect(result.errors?.[0]).toMatchObject({ code: 'knowledge_documents_missing' });
  });

  it('leaves knowledge-free deploys untouched with the gate off', async () => {
    const manifest = JSON.stringify({
      manifestVersion: '2',
      server: { name: 'plain_app', title: 'Plain', version: '1.0.0' },
      tools: [
        {
          name: 'ping',
          description: 'Ping.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    });
    const result = await registry.deploy(tenant, manifest, deployOptions);
    expect(result.ok).toBe(true);
  });
});
