import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway/portable';
import {
  SolutionInstallationListResponseSchema,
  SolutionInstallationResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';

let http: Server | undefined;
afterEach(async () => {
  if (http)
    await new Promise<void>((resolve, reject) =>
      http?.close((error) => (error ? reject(error) : resolve())),
    );
});
async function setup(requireOnboarding = false, configureEmbeds = true) {
  const store = new InMemoryBusinessInformationStore();
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const controlPlane = new InMemoryControlPlaneStore();
  const registry = new ServerRegistry();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'outsider',
    email: 'outsider@example.test',
    role: 'owner',
  });
  http = createServer(
    createServiceHandler(registry, {
      controlPlaneStore: controlPlane,
      businessInformationStore: store,
      ...(configureEmbeds ? { publicEmbeds } : {}),
      ...(requireOnboarding ? { businessOnboarding: {} } : {}),
      deployGate: {
        authorize: async (request) => {
          const subject = /^Bearer (owner|admin|viewer|outsider)$/.exec(
            String(request.headers.authorization ?? ''),
          )?.[1];
          return subject
            ? {
                ok: true,
                identity: { subject, email: `${subject}@example.test`, superAdmin: false },
              }
            : { ok: false, status: 401, message: 'authentication required' };
        },
      },
    }),
  );
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const request = (path: string, subject = 'owner', method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, publicEmbeds, registry, request };
}

describe('saved installation activation API', () => {
  it('preserves portable creation but refuses explicit activation success without configured public embed custody', async () => {
    const { registry, request } = await setup(false, false);
    const deploy = vi.spyOn(registry, 'deploy');
    const created = await request('/v1/orgs/acme/solution-installations', 'owner', 'POST', {
      definition: { kind: 'managed', profileId: 'travel' },
      appSlug: 'travel-desk',
      environment: 'prod',
      retentionDays: 30,
    });
    expect(created.status).toBe(201);
    const installation = SolutionInstallationResponseSchema.parse(await created.json()).data
      .installation;
    expect(installation.activation).toEqual({ state: 'unavailable', canRetry: false });
    const retry = await request(
      `/v1/orgs/acme/solution-installations/${installation.id}/activate`,
      'owner',
      'POST',
      {},
    );
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({
      ok: false,
      code: 'installation_activation_unavailable',
      installationId: installation.id,
    });
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it('keeps saved setup discoverable without bypassing current organization agreement and notice requirements', async () => {
    const { store, registry, request } = await setup(true);
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'saved' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const path = '/v1/orgs/acme/solution-installations/saved';
    const read = await request(path);
    expect(
      SolutionInstallationResponseSchema.parse(await read.json()).data.installation.activation,
    ).toEqual({ state: 'unavailable', canRetry: false });
    const retry = await request(`${path}/activate`, 'owner', 'POST', {});
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      code: 'business_setup_required',
      installationId: 'saved',
    });
    expect(await registry.getActiveByTenant(installation.scope)).toBeUndefined();
  });

  it('projects pending, repairs once through the same installation, and preserves explicit revocation', async () => {
    const { store, publicEmbeds, registry, request } = await setup();
    const deploy = vi.spyOn(registry, 'deploy');
    vi.spyOn(publicEmbeds, 'ensure').mockRejectedValueOnce(new Error('synthetic allocation loss'));
    const created = await request('/v1/orgs/acme/solution-installations', 'owner', 'POST', {
      definition: { kind: 'managed', profileId: 'travel' },
      appSlug: 'travel-desk',
      environment: 'prod',
      retentionDays: 30,
    });
    expect(created.status).toBe(503);
    const error = (await created.json()) as { installationId: string };
    const path = `/v1/orgs/acme/solution-installations/${error.installationId}`;
    const inspect = async () =>
      SolutionInstallationResponseSchema.parse(await (await request(path)).json()).data
        .installation;
    expect(await inspect()).toMatchObject({
      id: error.installationId,
      active: true,
      activation: { state: 'pending', canRetry: true },
    });
    const mine = await request('/v1/me/solution-installations');
    expect(
      SolutionInstallationListResponseSchema.parse(await mine.json()).data.installations[0]
        ?.activation,
    ).toEqual({ state: 'pending', canRetry: true });
    const saved = await store.getInstallationById('acme', error.installationId);
    if (!saved) throw new Error('saved installation missing');
    for (const [subject, role] of [
      ['admin', 'administrator'],
      ['viewer', 'viewer'],
    ] as const) {
      await store.setGrant({
        scope: saved.scope,
        subject,
        email: `${subject}@example.test`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
      const response = await request(path, subject);
      expect(
        SolutionInstallationResponseSchema.parse(await response.json()).data.installation.activation
          ?.canRetry,
      ).toBe(false);
      expect((await request(`${path}/activate`, subject, 'POST', {})).status).toBe(403);
    }
    expect((await request(`${path}/activate`, 'outsider', 'POST', {})).status).toBe(403);
    expect((await request(`${path}/activate`, 'missing', 'POST', {})).status).toBe(401);
    expect(
      (await request(`${path.replace('/acme/', '/other/')}/activate`, 'owner', 'POST', {})).status,
    ).toBe(404);
    expect((await request(`${path}/activate`, 'owner', 'POST', { appSlug: 'other' })).status).toBe(
      400,
    );
    expect((await request(`${path}/activate`, 'owner', 'GET')).status).toBe(405);
    for (let index = 0; index < 2; index++) {
      const retried = await request(`${path}/activate`, 'owner', 'POST', {});
      expect(retried.status, await retried.clone().text()).toBe(200);
      expect(
        SolutionInstallationResponseSchema.parse(await retried.json()).data.installation.activation,
      ).toEqual({ state: 'ready', canRetry: false });
    }
    expect(deploy).toHaveBeenCalledTimes(1);
    const [embed] = await publicEmbeds.list(saved.scope);
    await publicEmbeds.revoke(embed?.embedId ?? '', new Date());
    expect((await inspect()).activation).toEqual({ state: 'unavailable', canRetry: false });
    expect((await request(`${path}/activate`, 'owner', 'POST', {})).status).toBe(409);
    expect(await publicEmbeds.lookup(embed?.embedId ?? '')).toBeUndefined();
    expect(await publicEmbeds.list(saved.scope, { includeRevoked: true })).toHaveLength(1);
    expect(deploy).toHaveBeenCalledTimes(1);
  });
});
