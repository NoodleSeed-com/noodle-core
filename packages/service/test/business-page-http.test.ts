import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway/portable';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';
import { pageContent } from './business-page-conformance.js';

const scope = { org: 'pages', app: 'travel', env: 'prod', installationId: 'business' };
const portalOrigin = 'https://portal.example';
const notice = {
  displayName: 'Independent Travel',
  privacyUrl: 'https://example.com/privacy',
  supportUrl: 'mailto:help@example.com',
};
const target = {
  deploymentId: 'deployment-one',
  accessMode: 'public',
  served: {
    deps: {},
    artifact: {
      server: {
        assistant: {
          allowedOrigins: [portalOrigin],
          surfaces: [
            {
              mode: 'public',
              origins: [portalOrigin],
              capabilities: [{ kind: 'tool', name: 'capture_request' }],
            },
          ],
        },
      },
    },
  },
} as unknown as ServedTarget;

describe('business page API through the service dispatcher', () => {
  let server: Server, base: string, publicId: string;
  let store: InMemoryBusinessInformationStore;
  let registry: ServerRegistry;
  let embeds: InMemoryPublicEmbedStore;
  const privatePath = '/v1/orgs/pages/solution-installations/business/page';
  beforeEach(async () => {
    store = new InMemoryBusinessInformationStore();
    const created = await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    publicId = created.installation.publicId;
    await store.setBusinessNotice({ scope, notice, expectedRevision: 0, actorSubject: 'owner' });
    await store.setGrant({
      scope,
      subject: 'operator',
      email: 'operator@example.com',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    registry = new ServerRegistry();
    const generation = new Date().toISOString();
    await store.bindApplication(scope, generation);
    vi.spyOn(registry, 'getAppGeneration').mockResolvedValue(generation);
    vi.spyOn(registry, 'getActiveByTenant').mockResolvedValue(target);
    embeds = new InMemoryPublicEmbedStore();
    await embeds.ensure({ ...scope, surfaceMode: 'public', now: new Date() });
    server = createServer(
      createServiceHandler(registry, {
        businessInformationStore: store,
        businessPageOrigin: portalOrigin,
        publicBaseUrl: 'https://runtime.example',
        publicEmbeds: embeds,
        admissionCounters: new InMemoryDailyCounterStore(),
        deployGate: {
          authorize: async (request) => {
            const subject = request.headers.authorization?.replace(/^Bearer /, '');
            return subject
              ? {
                  ok: true,
                  identity: {
                    subject,
                    email: `${subject}@example.com`,
                    superAdmin: subject === 'super-admin',
                  },
                }
              : { ok: false, status: 401, message: 'Sign in required' };
          },
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  function request(method = 'GET', suffix = '', body?: unknown, actor = 'owner') {
    return fetch(`${base}${privatePath}${suffix}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor}` } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const publicRead = () => fetch(`${base}/v1/business-pages/${publicId}`);
  it('does not expose either page API until hosted pages are explicitly enabled', async () => {
    const disabled = createServer(
      createServiceHandler(registry, {
        businessInformationStore: store,
        publicBaseUrl: 'https://runtime.example',
      }),
    );
    await new Promise<void>((resolve) => disabled.listen(0, '127.0.0.1', resolve));
    const disabledBase = `http://127.0.0.1:${(disabled.address() as AddressInfo).port}`;
    try {
      for (const path of [
        privatePath,
        `${privatePath}/publish`,
        `/v1/business-pages/${publicId}`,
      ]) {
        expect((await fetch(`${disabledBase}${path}`)).status).toBe(404);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        disabled.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  async function publish() {
    expect((await request('PUT', '', { expectedRevision: 0, content: pageContent })).status).toBe(
      200,
    );
    const result = await request('POST', '/publish', { expectedRevision: 1 });
    expect(result.status, await result.text()).toBe(200);
  }
  it('makes no draft public, exposes only the published allowlist and unpublishes at the same URL', async () => {
    expect((await publicRead()).status).toBe(404);
    await publish();
    const response = await publicRead();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        publicId,
        content: pageContent,
        notice,
        assistant: {
          embedId: (await embeds.list(scope))[0]!.embedId,
          serviceUrl: 'https://runtime.example',
          scriptUrl: 'https://runtime.example/v1/assistant/embed.js',
        },
      },
    });
    await request('PUT', '', {
      expectedRevision: 2,
      content: { ...pageContent, introduction: 'secret draft change' },
    });
    expect(await (await publicRead()).text()).not.toContain('secret draft');
    expect((await request('POST', '/unpublish', { expectedRevision: 3 })).status).toBe(200);
    expect((await publicRead()).status).toBe(404);
    expect((await request('GET')).headers.get('cache-control')).toBe('private, no-store');
  });
  it('authorizes private reads and every mutation independently of developer or super-admin identity', async () => {
    expect((await request('GET', '', undefined, '')).status).toBe(401);
    for (const actor of ['operator', 'stranger', 'super-admin']) {
      expect((await request('GET', '', undefined, actor)).status).toBe(403);
      expect(
        (await request('PUT', '', { expectedRevision: 0, content: pageContent }, actor)).status,
      ).toBe(403);
      expect((await request('POST', '/publish', { expectedRevision: 1 }, actor)).status).toBe(403);
    }
  });
  it('requires exact revisions and refuses browser-supplied authority, publication and markup fields', async () => {
    for (const extra of [{ published: true }, { actorSubject: 'owner' }, { html: '<script/>' }])
      expect(
        (await request('PUT', '', { expectedRevision: 0, content: pageContent, ...extra })).status,
      ).toBe(400);
    await publish();
    expect((await request('POST', '/publish', { expectedRevision: 1 })).status).toBe(409);
    expect((await request('DELETE')).status).toBe(405);
    expect((await request('GET', '/publish')).status).toBe(405);
    expect((await fetch(`${base}/v1/business-pages/${publicId}`, { method: 'POST' })).status).toBe(
      405,
    );
  });
  it('preserves approved information with no assistant when channels are unavailable, but hides invalid custody or notice', async () => {
    await publish();
    const generation = await registry.getAppGeneration(scope.org, scope.app);
    vi.mocked(registry.getAppGeneration).mockResolvedValue('different-generation');
    expect((await publicRead()).status).toBe(404);
    vi.mocked(registry.getAppGeneration).mockResolvedValue(generation);
    vi.mocked(registry.getActiveByTenant).mockResolvedValue(undefined);
    expect(await (await publicRead()).json()).toMatchObject({
      data: { content: pageContent, assistant: null },
    });
    vi.mocked(registry.getActiveByTenant).mockResolvedValue({
      ...target,
      deploymentId: 'new-deployment',
    });
    expect(await (await publicRead()).json()).toMatchObject({
      data: { content: pageContent, assistant: null },
    });
    vi.mocked(registry.getActiveByTenant).mockResolvedValue(target);
    await store.setBusinessNotice({
      scope,
      notice: { ...notice, displayName: 'Changed name' },
      expectedRevision: 1,
      actorSubject: 'owner',
    });
    expect((await publicRead()).status).toBe(404);
    expect((await request('POST', '/publish', { expectedRevision: 2 })).status).toBe(200);
    await embeds.revoke((await embeds.list(scope))[0]!.embedId, new Date());
    expect(await (await publicRead()).json()).toMatchObject({
      data: { content: pageContent, assistant: null },
    });
    expect((await request('POST', '/publish', { expectedRevision: 3 })).status).toBe(409);
  });
  it('keeps a published business page useful while its assistant is paused, without widening admission', async () => {
    await publish();
    const installation = await store.getInstallation(scope);
    expect(installation).toBeDefined();
    await store.setIntakeState({
      scope,
      expectedRevision: installation!.revision,
      actorSubject: 'owner',
      active: false,
    });
    const response = await publicRead();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { content: pageContent, assistant: null },
    });
    expect((await request('POST', '/publish', { expectedRevision: 2 })).status).toBe(409);
  });
  it('refuses publishing for another allowed website origin and never echoes storage errors', async () => {
    vi.mocked(registry.getActiveByTenant).mockResolvedValue({
      ...target,
      served: {
        ...target.served,
        artifact: {
          ...target.served.artifact,
          server: {
            ...target.served.artifact.server,
            assistant: {
              allowedOrigins: ['https://other.example'],
              surfaces: [
                {
                  mode: 'public',
                  origins: ['https://other.example'],
                  capabilities: [{ kind: 'tool', name: 'capture_request' }],
                },
              ],
            },
          },
        },
      },
    } as ServedTarget);
    await request('PUT', '', { expectedRevision: 0, content: pageContent });
    expect((await request('POST', '/publish', { expectedRevision: 1 })).status).toBe(409);
    vi.spyOn(store.pages, 'get').mockRejectedValue(
      new Error('private ciphertext and business text'),
    );
    const result = await request();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('ciphertext');
  });
});
