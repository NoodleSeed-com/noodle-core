import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway/portable';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { InMemoryArtifactStore, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';
import {
  type BusinessChannelRouteDeps,
  handleBusinessChannels,
} from '../src/routes/business-information-channels.js';

const scope = { org: 'acme', app: 'site', env: 'production', installationId: 'installation-1' };
const origin = 'https://www.acme.test';
const target = {
  deploymentId: 'deployment-1',
  accessMode: 'public',
  served: {
    deps: {},
    artifact: {
      server: {
        assistant: {
          allowedOrigins: [origin],
          surfaces: [
            {
              mode: 'public',
              origins: [origin],
              capabilities: [{ kind: 'tool', name: 'capture_request' }],
            },
          ],
        },
      },
    },
  },
} as unknown as ServedTarget;
let http: Server;
let base: string;
let deps: BusinessChannelRouteDeps;
let store: InMemoryBusinessInformationStore;
let embeds: InMemoryPublicEmbedStore;
let counters: InMemoryDailyCounterStore;
let active: ReturnType<typeof vi.spyOn<ServerRegistry, 'getActiveByTenant'>>;

beforeEach(async () => {
  store = new InMemoryBusinessInformationStore();
  await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    retentionDays: 30,
    actorSubject: 'owner',
    actorEmail: 'owner@example.com',
  });
  await store.setGrant({
    scope,
    subject: 'operator',
    email: 'operator@example.com',
    role: 'operator',
    expectedRevision: 0,
    actorSubject: 'owner',
  });
  embeds = new InMemoryPublicEmbedStore();
  counters = new InMemoryDailyCounterStore();
  const registry = new ServerRegistry(new InMemoryArtifactStore());
  active = vi.spyOn(registry, 'getActiveByTenant').mockResolvedValue(target);
  deps = {
    store,
    registry,
    publicEmbeds: embeds,
    publicCounters: counters,
    admissionCounters: counters,
    controlPlane: new InMemoryControlPlaneStore(),
    trustProxy: false,
    maxBody: 64000,
    resolveEndpointBase: () => 'https://cloud.example',
    gate: {
      authorize: async (req) => {
        const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
        return ['owner', 'operator', 'stranger'].includes(token)
          ? {
              ok: true,
              identity: { subject: token, email: `${token}@example.com`, superAdmin: false },
            }
          : { ok: false, status: 401, message: 'Sign in required' };
      },
    },
  };
  http = createServer((req, res) => {
    void handleBusinessChannels(
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
const read = async (token = 'owner') =>
  fetch(base, { headers: { authorization: `Bearer ${token}` } });
const patch = async (body: unknown, token = 'owner') =>
  fetch(base, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('business channel projection and authority', () => {
  it('shows actual runtime MCP and stable assistant embed identity rather than form URLs', async () => {
    const embed = await embeds.ensure({ ...scope, surfaceMode: 'public', now: new Date() });
    await counters.consume({ key: `turns:${embed.embedId}`, limit: 100 }, new Date());
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      data: {
        active: true,
        canEdit: true,
        deploymentId: 'deployment-1',
        mcp: { status: 'ready', accessMode: 'public' },
        assistant: {
          status: 'ready',
          embedId: embed.embedId,
          scriptUrl: 'https://cloud.example/v1/assistant/embed.js',
          origins: [origin],
          capabilities: ['capture_request'],
          usage: { turnsToday: 1 },
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('/intake/');
    expect(JSON.stringify(payload)).not.toContain('credit');
    expect(active).toHaveBeenCalledWith({ org: scope.org, app: scope.app, env: scope.env });
  });
  it('keeps a records-only installation honestly unavailable for agent channels', async () => {
    active.mockResolvedValue(undefined);
    expect(await (await read()).json()).toMatchObject({
      data: { mcp: { status: 'unavailable' }, assistant: { status: 'unavailable' } },
    });
  });
  it('requires an installation grant independently of developer/org membership', async () => {
    expect((await read('stranger')).status).toBe(403);
    expect(active).not.toHaveBeenCalled();
    const response = await read('operator');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { canEdit: false } });
    expect((await patch({ expectedRevision: 1, active: false }, 'operator')).status).toBe(403);
  });
  it('records a revisioned pause without deleting the stable embed or resetting its budget', async () => {
    const embed = await embeds.ensure({ ...scope, surfaceMode: 'public', now: new Date() });
    await embeds.setBudget(embed.embedId, { turnsPerDay: 200 }, new Date());
    expect(await (await patch({ expectedRevision: 1, active: false })).json()).toMatchObject({
      data: {
        revision: 2,
        active: false,
        mcp: { status: 'paused' },
        assistant: { status: 'paused', embedId: embed.embedId },
      },
    });
    expect((await embeds.lookup(embed.embedId))?.turnsPerDay).toBe(200);
    expect((await patch({ expectedRevision: 1, active: true })).status).toBe(409);
  });
  it('does not accept imaginary origin overrides or pick a revoked public embed', async () => {
    expect(
      (await patch({ expectedRevision: 1, active: true, origins: ['https://attacker.example'] }))
        .status,
    ).toBe(400);
    const embed = await embeds.ensure({ ...scope, surfaceMode: 'public', now: new Date() });
    await embeds.revoke(embed.embedId, new Date());
    expect(await (await read()).json()).toMatchObject({
      data: { assistant: { status: 'unavailable' } },
    });
  });
});
