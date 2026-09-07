import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceHandler, ServerRegistry } from '../src/index.js';
import { createAcmeControlPlane } from './control-plane-test-helpers.js';

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

const BROKEN = `
manifestVersion: "1"
server:
  name: broken
  version: 1.0.0
tools: []
`;

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const OWNER_TOKEN = 'OWNER';

let http: Server;
let base: string;
let lines: string[];

beforeEach(async () => {
  lines = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const controlPlane = await createAcmeControlPlane();
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      logger,
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
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

const records = (event: string): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line)).filter((rec) => rec.event === event);

function deploy(manifest: string): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/logging/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}

describe('structured logging (Slice 27)', () => {
  it('logs deploy.ok with counts only — no secret names/values or bearer tokens', async () => {
    const dep = await (await deploy(HELLO)).json();
    const ok = records('deploy.ok');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      deploymentId: dep.deploymentId,
      org: 'acme',
      app: 'logging',
      env: 'prod',
      hasConnectors: false,
    });
    expect(lines.join('\n')).not.toContain(OWNER_TOKEN);
  });

  it('logs deploy.rejected with safe error codes for a broken manifest', async () => {
    await deploy(BROKEN);
    const rejected = records('deploy.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe(400);
    expect(rejected[0]?.errorCount as number).toBeGreaterThan(0);
    expect(typeof rejected[0]?.codes).toBe('string');
  });

  it('logs mcp.request with method/status/tenant route/latency and no auth material', async () => {
    const dep = await (await deploy(HELLO)).json();
    lines.length = 0; // focus on the request lifecycle
    await fetch(dep.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    const reqs = records('mcp.request');
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    const last = reqs[reqs.length - 1];
    expect(last?.serverId).toBe('acme/logging/prod@1');
    expect(last?.method).toBe('POST');
    expect(last?.status).toBe(200);
    expect(typeof last?.latencyMs).toBe('number');
    // The bearer token sent in the Authorization header must never reach a log line.
    expect(lines.join('\n')).not.toContain(OWNER_TOKEN);
  });
});
