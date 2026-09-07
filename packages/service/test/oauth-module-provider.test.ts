import { MODULE_API_VERSION, type PlatformHumanIdentityContribution } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryControlPlaneStore, serveService } from '../src/index.js';
import { resolveServiceOAuthBootstrap } from '../src/oauth/service-bootstrap.js';

const PING_MANIFEST = `
manifestVersion: "1"
server:
  name: ping
  version: 1.0.0
  title: Ping
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;

describe('OAuth module providers', () => {
  it('threads the platform-human principal resolver into access-token continuity checks', async () => {
    const resolveExisting = vi.fn(async () => {
      throw new Error('principal suspended');
    });
    const platformHumanIdentity: PlatformHumanIdentityContribution = {
      principalResolver: {
        resolve: async (identity) => ({
          subject: identity.subject,
        }),
        resolveLinked: async () => undefined,
        hasVerifiedEmailEvidence: async () => true,
        assertEmailAvailable: async () => undefined,
        resolveExisting,
        assertActive: async () => undefined,
        lookupActiveVerifiedEmails: async () => ({ kind: 'known', emails: [] }),
      },
    };
    const bootstrap = await resolveServiceOAuthBootstrap({
      options: {
        verifyOwnerToken: async () => ({
          caller: { subject: 'principal-1', identityKind: 'platform' },
        }),
      },
      controlPlaneStore: new InMemoryControlPlaneStore(),
      platformAuth: {},
      platformHumanIdentity,
      registry: () => undefined,
    });

    await expect(
      bootstrap.verifyOwnerToken?.('token', 'https://resource.test'),
    ).resolves.toBeNull();
    expect(resolveExisting).toHaveBeenCalledWith('principal-1');
  });

  it('wraps a module token verifier before the running service consumes it', async () => {
    const resolveExisting = vi.fn(async () => {
      throw new Error('principal suspended');
    });
    const authVerifier = vi.fn(async () => ({
      caller: { subject: 'principal-1', identityKind: 'platform' as const },
    }));
    const controlPlaneStore = new InMemoryControlPlaneStore();
    await controlPlaneStore.createOrg({ slug: 'acme' });
    const service = await serveService({
      port: 0,
      controlPlaneStore,
      deployGate: {
        authorize: async () => ({
          ok: true,
          identity: {
            subject: 'principal-1',
            email: 'owner@example.test',
            superAdmin: true,
          },
        }),
      },
      modules: [
        {
          name: 'identity',
          version: '0.0.0',
          apiVersion: MODULE_API_VERSION,
          init: () => ({
            authVerifier,
            platformHumanIdentity: {
              principalResolver: {
                resolve: async (identity) => ({
                  subject: identity.subject,
                }),
                resolveLinked: async () => undefined,
                hasVerifiedEmailEvidence: async () => true,
                assertEmailAvailable: async () => undefined,
                resolveExisting,
                assertActive: async () => undefined,
                lookupActiveVerifiedEmails: async () => ({ kind: 'known', emails: [] }),
              },
            },
          }),
        },
      ],
    });
    try {
      const deployed = await fetch(`${service.url}/v1/orgs/acme/apps/ping/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: PING_MANIFEST, accessMode: 'owner-only' }),
      });
      expect(deployed.status).toBe(201);
      const { url } = (await deployed.json()) as { readonly url: string };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer MODULE',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25' },
        }),
      });

      expect(response.status).toBe(401);
      expect(authVerifier).toHaveBeenCalled();
      expect(resolveExisting).toHaveBeenCalledWith('principal-1');
    } finally {
      await service.close();
    }
  });
});
