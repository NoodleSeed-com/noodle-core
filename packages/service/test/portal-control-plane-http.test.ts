import { createStaticSigningKeyProvider, mintAccessToken } from '@noodle-borg/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryControlPlaneStore, serveService } from '../src/index.js';

const issuer = 'https://service.example';
const manifest = `manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema: {type: object, additionalProperties: false}
    fulfilment:
      steps:
        - id: reply
          map: {message: Hello}
      output: {message: "\${steps.reply.message}"}
`;

describe('Portal client ceiling through the normal HTTP bootstrap', () => {
  let service: Awaited<ReturnType<typeof serveService>>;
  let signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
  const controlPlane = new InMemoryControlPlaneStore();
  beforeAll(async () => {
    signer = await createStaticSigningKeyProvider();
    service = await serveService({
      port: 0,
      publicBaseUrl: issuer,
      controlPlaneStore: controlPlane,
      controlPlaneSignupMode: 'public',
      oauth: {
        issuer,
        signer,
        google: {
          authorizationUrl: (state) => `https://google.example/auth?state=${state}`,
          exchange: async () => ({ subject: 'owner', email: 'owner@example.com' }),
        },
        consoleClient: {
          clientId: 'console',
          redirectUri: 'https://console.example/api/console/auth/callback',
        },
        portalClient: {
          clientId: 'portal',
          redirectUri: 'https://portal.example/api/portal/auth/callback',
        },
      },
    });
  });
  afterAll(async () => {
    await service?.close();
  });
  const token = (oauthClientId: string, audience = `${issuer}/`) =>
    mintAccessToken(
      signer,
      {
        issuer,
        subject: 'owner',
        email: 'owner@example.com',
        audience,
        oauthClientId,
        scope: 'openid email',
      },
      300,
    );
  const call = async (path: string, credential: string, method = 'GET', body?: unknown) =>
    fetch(`${service.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'x-client-id': 'console',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('bootstraps the same ordinary owner but requires a separate developer token for technical APIs', async () => {
    const portal = await token('portal');
    const identity = await call('/v1/whoami', portal);
    expect(identity.status).toBe(200);
    const body = (await identity.json()) as { orgs: Array<{ slug: string }> };
    const org = body.orgs[0]?.slug;
    if (!org) throw new Error('Missing ordinary workspace');
    expect(await controlPlane.getOrgMember({ org, subject: 'owner' })).toMatchObject({
      role: 'owner',
    });
    expect((await call('/v1/me/solution-installations', portal)).status).toBe(200);
    expect((await call('/v1/me/solution-installation-options', portal)).status).toBe(200);
    const deploy = `/v1/orgs/${org}/apps/hello/envs/prod/deploy`;
    expect((await call(deploy, portal, 'POST', { manifest })).status).toBe(403);
    expect((await call(`/v1/orgs/${org}/members`, portal)).status).toBe(403);
    expect((await call(`/v1/orgs/${org}/variables`, portal)).status).toBe(403);
    const consoleToken = await token('console');
    expect((await call(deploy, consoleToken, 'POST', { manifest })).status).toBe(201);
    expect((await call(`/v1/orgs/${org}/apps`, consoleToken)).status).toBe(200);
    expect((await call(`/v1/orgs/${org}/apps`, portal)).status).toBe(403);
  });

  it('rejects wrong audience, tampered client identity, and an unknown signed client registration', async () => {
    expect((await call('/v1/whoami', await token('portal', 'https://other.example/'))).status).toBe(
      401,
    );
    const original = await token('portal');
    const parts = original.split('.');
    const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    parts[1] = Buffer.from(JSON.stringify({ ...payload, client_id: 'console' })).toString(
      'base64url',
    );
    expect((await call('/v1/whoami', parts.join('.'))).status).toBe(401);
    expect((await call('/v1/whoami', await token('missing-registration'))).status).toBe(403);
  });
});
