import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { sha256Canonical } from '@noodle-borg/compiler';
import { ApplicationSettingsClientResponseSchema } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { InMemoryControlPlaneStore } from '../src/index.js';
import type { BusinessInformationRouteDeps } from '../src/routes/business-information.js';
import { handleBusinessSettings } from '../src/routes/business-information-settings.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';

const scope = { org: 'acme', app: 'site', env: 'production', installationId: 'installation-1' };
const configScope = { level: 'env', ...scope } as const;
const declaration = {
  name: 'DURATION',
  schemaVersion: 1 as const,
  valueSchema: { type: 'integer', minimum: 15, maximum: 90 },
  default: 30,
  portal: { label: 'Duration' },
  requiredFor: ['book'],
};
let http: Server;
let base: string;
let deps: BusinessInformationRouteDeps;
let config: InMemoryConfigStore;
let store: InMemoryBusinessInformationStore;
const emit = vi.fn();

beforeEach(async () => {
  emit.mockReset();
  config = new InMemoryConfigStore();
  store = new InMemoryBusinessInformationStore();
  await store.createInstallation({
    scope,
    managedCollections: [],
    actorSubject: 'owner',
    actorEmail: 'owner@example.com',
    definition: {
      title: 'Custom application',
      description: 'Settings proof',
      collections: [],
      reference: {
        kind: 'private',
        publisherOrg: 'acme',
        app: 'site',
        env: 'production',
        deploymentId: 'deployment-1',
        version: '1.0.0',
        digest: 'a'.repeat(64),
      },
      variables: [{ ...declaration, schemaDigest: sha256Canonical(declaration) }],
    },
  });
  await store.setGrant({
    scope,
    subject: 'viewer',
    email: 'viewer@example.com',
    role: 'viewer',
    expectedRevision: 0,
    actorSubject: 'owner',
  });
  await config.setConfigValue({
    kind: 'secret',
    scope: configScope,
    name: 'PROVIDER_TOKEN',
    value: 'never-expose-secret',
  });
  await config.setConfigValue({
    kind: 'variable',
    scope: configScope,
    name: 'TECHNICAL',
    value: 'never-expose-technical',
  });
  deps = {
    store,
    configStore: config,
    publicCounters: new InMemoryDailyCounterStore(),
    controlPlane: new InMemoryControlPlaneStore(),
    trustProxy: false,
    maxBody: 64000,
    audit: { emit },
    gate: {
      authorize: async (req) => {
        const subject = String(req.headers.authorization ?? '').replace('Bearer ', '');
        return ['owner', 'viewer', 'developer'].includes(subject)
          ? {
              ok: true,
              identity: {
                subject,
                email: `${subject}@example.com`,
                superAdmin: subject === 'developer',
              },
            }
          : { ok: false, status: 401, message: 'Sign in required' };
      },
    },
  };
  http = createServer((req, res) => {
    void handleBusinessSettings(
      req,
      res,
      { org: scope.org, installationId: scope.installationId },
      deps,
    ).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});
const read = (token = 'owner') => fetch(base, { headers: { authorization: `Bearer ${token}` } });
const patch = (body: unknown, token = 'owner') =>
  fetch(base, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const projection = async () =>
  ApplicationSettingsClientResponseSchema.parse(await (await read()).json()).data;

describe('business settings HTTP authority and concurrency', () => {
  it('exposes declared business settings without credentials or technical configuration', async () => {
    const response = await read('viewer');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const payload = await response.json();
    expect(payload).toMatchObject({
      data: { canEdit: false, values: { DURATION: 30 }, provenance: { DURATION: 'default' } },
    });
    expect(JSON.stringify(payload)).not.toContain('never-expose');
    expect(ApplicationSettingsClientResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('requires a live business grant even for developer or platform administrators', async () => {
    expect((await read('')).status).toBe(401);
    expect((await read('developer')).status).toBe(403);
    const current = await projection();
    expect(
      (
        await patch(
          {
            expectedRevision: current.revision,
            schemaDigest: current.schemaDigest,
            values: { DURATION: 45 },
          },
          'viewer',
        )
      ).status,
    ).toBe(403);
    await store.revokeGrant({
      scope,
      subject: 'viewer',
      expectedRevision: 1,
      actorSubject: 'owner',
    });
    expect((await read('viewer')).status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it('atomically saves only one concurrent revision and emits value-free evidence', async () => {
    const current = await projection();
    const input = {
      expectedRevision: current.revision,
      schemaDigest: current.schemaDigest,
      values: { DURATION: 75 },
    };
    const replies = await Promise.all([patch(input), patch(input)]);
    expect(replies.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await projection()).values).toEqual({ DURATION: 75 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'owner',
        details: { changedKeys: 'DURATION', revision: expect.any(String) },
      }),
    );
  });

  it('rejects undeclared keys and invalid values without partial writes', async () => {
    const current = await projection();
    const binding = { expectedRevision: current.revision, schemaDigest: current.schemaDigest };
    expect(
      (await patch({ ...binding, values: { DURATION: 60, TECHNICAL: 'change' } })).status,
    ).toBe(400);
    expect((await patch({ ...binding, values: { DURATION: '60' } })).status).toBe(400);
    expect((await projection()).revision).toBe(current.revision);
    expect(emit).not.toHaveBeenCalled();
  });

  it('invalidates a stale browser revision after inherited configuration changes', async () => {
    const current = await projection();
    await config.setConfigValue({
      kind: 'variable',
      scope: { level: 'org', org: scope.org },
      name: 'DURATION',
      value: '45',
    });
    expect(
      (
        await patch({
          expectedRevision: current.revision,
          schemaDigest: current.schemaDigest,
          values: { DURATION: 60 },
        })
      ).status,
    ).toBe(409);
    expect(await projection()).toMatchObject({
      values: { DURATION: 45 },
      provenance: { DURATION: 'organization' },
    });
  });

  it('fails closed when atomic storage is absent instead of silently using memory', async () => {
    deps = { ...deps, configStore: undefined };
    expect((await read()).status).toBe(503);
  });
});
