import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ResendEmailSender,
  ServerRegistry,
  WelcomeEmailWorker,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
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

describe('public control-plane signup provisioning', () => {
  const verifier: GoogleIdTokenVerifier = {
    verify: async (token: string) => {
      if (token === 'external')
        return { subject: 'sub-external', email: 'Alex@Example.com', givenName: 'Alex' };
      if (token === 'same-email') return { subject: 'sub-other', email: 'alex@example.com' };
      if (token === 'admin') return { subject: 'sub-admin', email: 'admin@noodleseed.com' };
      throw new Error('bad token');
    },
  };

  async function listenPublicControlPlane(): Promise<{
    url: string;
    artifacts: InMemoryArtifactStore;
    controlPlane: InMemoryControlPlaneStore;
    close: () => Promise<void>;
  }> {
    const artifacts = new InMemoryArtifactStore();
    const controlPlane = new InMemoryControlPlaneStore();
    const srv = createServer(
      createServiceHandler(new ServerRegistry(artifacts), {
        controlPlaneSignupMode: 'public',
        controlPlaneStore: controlPlane,
        deployGate: new GoogleControlPlaneGate({
          audience: 'client-id',
          admins: ['admin@noodleseed.com'],
          signupMode: 'public',
          verifier,
        }),
      }),
    );
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      artifacts,
      controlPlane,
      close: () =>
        new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  async function whoami(
    baseUrl: string,
    token: string,
  ): Promise<{
    identity: { subject: string; email: string; superAdmin: boolean };
    orgs: readonly { slug: string; displayName?: string }[];
  }> {
    const res = await fetch(`${baseUrl}/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      identity: { subject: string; email: string; superAdmin: boolean };
      orgs: readonly { slug: string; displayName?: string }[];
    };
  }

  function deployWith(baseUrl: string, token: string, org: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/orgs/${org}/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ manifest: HELLO }),
    });
  }

  it('creates a stable personal org for first-time external users and permits deploy there only', async () => {
    const srv = await listenPublicControlPlane();
    try {
      const first = await whoami(srv.url, 'external');
      expect(first.identity).toMatchObject({
        subject: 'sub-external',
        email: 'alex@example.com',
        superAdmin: false,
      });
      expect(first.orgs).toHaveLength(1);
      expect(await srv.controlPlane.getWelcomeEmail('sub-external')).toMatchObject({
        email: 'alex@example.com',
        firstName: 'Alex',
        attemptCount: 0,
      });
      const resendFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: 'email_welcome' }));
      const worker = new WelcomeEmailWorker({
        store: srv.controlPlane,
        sender: new ResendEmailSender({
          apiKey: 'test-resend-key',
          welcomeFrom: 'Asad <asad@noodleseed.com>',
          invitationFrom: 'Noodle Seed <hello@noodleseed.com>',
          fetch: resendFetch,
        }),
      });
      await worker.runOnce();
      expect(resendFetch).toHaveBeenCalledOnce();
      const welcomeRequest = JSON.parse(String(resendFetch.mock.calls[0]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(welcomeRequest).toMatchObject({
        from: 'Asad <asad@noodleseed.com>',
        to: ['alex@example.com'],
        subject: 'Welcome to Noodle Seed',
      });
      expect(welcomeRequest.html).toContain('Hi Alex,');
      expect(await srv.controlPlane.getWelcomeEmail('sub-external')).toMatchObject({
        providerMessageId: 'email_welcome',
      });
      const personalOrg = first.orgs[0]?.slug ?? '';
      expect(personalOrg).toMatch(/^u-alex-[0-9a-f]{8}$/);

      const again = await whoami(srv.url, 'external');
      expect(again.orgs.map((org) => org.slug)).toEqual([personalOrg]);
      expect(await srv.controlPlane.getWelcomeEmail('sub-external')).toMatchObject({
        attemptCount: 1,
        providerMessageId: 'email_welcome',
      });
      await worker.runOnce();
      expect(resendFetch).toHaveBeenCalledOnce();

      const sameEmail = await whoami(srv.url, 'same-email');
      expect(sameEmail.orgs[0]?.slug).toMatch(/^u-alex-[0-9a-f]{8}$/);
      expect(sameEmail.orgs[0]?.slug).not.toBe(personalOrg);

      expect((await deployWith(srv.url, 'external', personalOrg)).status).toBe(201);
      expect((await deployWith(srv.url, 'external', 'someone-else')).status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it('keeps super-admin users separate from automatic personal org provisioning', async () => {
    const srv = await listenPublicControlPlane();
    try {
      const admin = await whoami(srv.url, 'admin');
      expect(admin.identity.superAdmin).toBe(true);
      expect(admin.orgs).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});
