import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
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

let http: Server | undefined;
const OWNER_TOKEN = 'OWNER';

async function start(options: ServiceOptions): Promise<string> {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
      ...options,
    }),
  );
  http = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  const server = http;
  http = undefined;
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

function deploy(base: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/tls/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ manifest: HELLO }),
  });
}

describe('TLS / HTTPS posture (Slice 28)', () => {
  it('default: baseline security headers, no HSTS, no HTTPS enforcement, http url', async () => {
    const base = await start({});
    const res = await deploy(base);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect((await res.json()).url).toMatch(/^http:\/\//);
  });

  it('trustProxy: rejects a plaintext (proxy-reported http) request with 426 before auth/body', async () => {
    const base = await start({ tls: { trustProxy: true } });
    const res = await deploy(base, { 'x-forwarded-proto': 'http' });
    expect(res.status).toBe(426);
    expect(res.headers.get('upgrade')).toMatch(/TLS/);
  });

  it('trustProxy + https: passes, returns an https url, and emits HSTS', async () => {
    const base = await start({ tls: { trustProxy: true } });
    const res = await deploy(base, { 'x-forwarded-proto': 'https' });
    expect(res.status).toBe(201);
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect((await res.json()).url).toMatch(/^https:\/\//);
  });
});
