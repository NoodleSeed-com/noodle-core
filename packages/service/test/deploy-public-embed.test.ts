import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InMemoryPublicEmbedStore,
  type PublicEmbedRecord,
  type PublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * Deploy provisions the public embed id.
 *
 * This is what makes a public surface reachable at all: the mint route resolves a browser's `embedId`,
 * and until deploy creates one there is nothing for a page to present. Provisioning on deploy rather
 * than through a separate `noodle assistant embeds create` is the point of ADR 0201's one-line
 * experience — the developer pastes a snippet, never runs a provisioning command.
 */

const ASSISTANT_APP = (mode: 'public' | 'mixed' | 'authenticated') => `
manifestVersion: "1"
server:
  name: site
  version: 1.0.0
  title: Site
  assistant:
    model:
      kind: openai-compatible
      baseUrl: https://models.test/v1
      model: gemini-flash
      apiKey: ASSISTANT_MODEL_KEY
    allowedOrigins:
      - https://www.acme.test
    surfaces:
      - mode: ${mode}
        origins:
          - https://www.acme.test
${
  mode === 'authenticated'
    ? ''
    : `        capabilities:
          - kind: tool
            name: greet
`
}tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

const NO_ASSISTANT = `
manifestVersion: "1"
server:
  name: site
  version: 1.0.0
  title: Site
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: hi
      output:
        message: \${steps.build.message}
`;

interface DeployBody {
  readonly ok?: boolean;
  readonly embedId?: string;
  readonly errors?: readonly unknown[];
}

let http: Server;
let base: string;
let embeds: PublicEmbedStore | undefined;
let ensureCalls: number;
let appLogs: { readonly level: string; readonly message: string }[];

async function start(): Promise<void> {
  const configStore = new InMemoryConfigStore();
  await configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'env', org: 'acme', app: 'site', env: 'prod' },
    name: 'ASSISTANT_MODEL_KEY',
    value: 'sk-test',
  });
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
      configStore,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      ...(embeds ? { publicEmbeds: embeds } : {}),
      userAppLogStore: {
        emit: async (entry: { level: string; message: string }) => {
          appLogs.push({ level: entry.level, message: entry.message });
        },
      },
    } as Parameters<typeof createServiceHandler>[1]),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function countingStore(inner: PublicEmbedStore): PublicEmbedStore {
  return {
    ensure: (input) => {
      ensureCalls += 1;
      return inner.ensure(input);
    },
    lookup: (embedId) => inner.lookup(embedId),
    list: (tenant) => inner.list(tenant),
    revoke: (embedId, now) => inner.revoke(embedId, now),
  };
}

beforeEach(() => {
  ensureCalls = 0;
  appLogs = [];
  embeds = countingStore(new InMemoryPublicEmbedStore());
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

async function deploy(manifest: string, extra: Record<string, unknown> = {}): Promise<DeployBody> {
  const response = await fetch(`${base}/v1/orgs/acme/apps/site/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, serverVersion: '1', ...extra }),
  });
  const body = (await response.json()) as DeployBody;
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body;
}

describe('deploy provisions a public embed id', () => {
  it('returns a non-secret embed id when the app declares a public surface', async () => {
    await start();
    const body = await deploy(ASSISTANT_APP('public'));

    expect(body.embedId).toMatch(/^pub_[0-9a-z]{20,32}$/);
    // The record is real, not just an echo: the mint route resolves the browser's id through `lookup`.
    const found = (await embeds?.lookup(body.embedId as string)) as PublicEmbedRecord;
    expect(found).toMatchObject({ org: 'acme', app: 'site', env: 'prod', surfaceMode: 'public' });
  });

  it('provisions for a mixed surface too', async () => {
    await start();
    const body = await deploy(ASSISTANT_APP('mixed'));
    expect((await embeds?.lookup(body.embedId as string))?.surfaceMode).toBe('mixed');
  });

  /**
   * The paste-once promise. A customer's page carries the id for months; a redeploy that minted a fresh
   * one would silently break every page already carrying the old.
   */
  it('returns the same id on redeploy', async () => {
    await start();
    const first = await deploy(ASSISTANT_APP('public'));
    const second = await deploy(ASSISTANT_APP('public'));

    expect(first.embedId).toBeDefined();
    expect(second.embedId).toBe(first.embedId);
  });

  it('keeps the id when the author turns a public surface into a mixed one', async () => {
    await start();
    const first = await deploy(ASSISTANT_APP('public'));
    const second = await deploy(ASSISTANT_APP('mixed'));

    // The stored `surfaceMode` goes stale by design — `ensure` never overwrites a live row. Nothing
    // reads it at mint time, and the embeds list view corrects it from the active deployment.
    expect(first.embedId).toBeDefined();
    expect(second.embedId).toBe(first.embedId);
  });

  it('provisions nothing for an authenticated-only surface', async () => {
    await start();
    const body = await deploy(ASSISTANT_APP('authenticated'));

    expect(body.embedId).toBeUndefined();
    expect(ensureCalls).toBe(0);
  });

  it('provisions nothing for an app with no assistant at all', async () => {
    await start();
    const body = await deploy(NO_ASSISTANT);

    expect(body.embedId).toBeUndefined();
    expect(ensureCalls).toBe(0);
  });

  /**
   * By the time provisioning runs the deployment is already live. A store failure must never turn a
   * live deployment into a failed deploy — the developer sees no snippet, and a redeploy retries for
   * free because `ensure` is idempotent.
   */
  it('still succeeds when the embed store fails', async () => {
    embeds = {
      ensure: () => Promise.reject(new Error('embed store unavailable')),
      lookup: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      revoke: () => Promise.resolve(false),
    };
    await start();
    const body = await deploy(ASSISTANT_APP('public'));

    expect(body.embedId).toBeUndefined();
    expect(appLogs.map((entry) => entry.message)).toContain(
      'public assistant embed id could not be provisioned',
    );
  });

  it('succeeds without an embed store configured', async () => {
    embeds = undefined;
    await start();
    const body = await deploy(ASSISTANT_APP('public'));
    expect(body.embedId).toBeUndefined();
  });
});
