import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  InMemoryUserAppLogStore,
  ServerRegistry,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet.
    inputSchema:
      type: object
      properties:
        name: { type: string }
      required: [name]
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

describe('tenant-safe user-app logs route (M3)', () => {
  let http: Server;
  let base: string;
  let logs: InMemoryUserAppLogStore;

  beforeEach(async () => {
    const controlPlane = new InMemoryControlPlaneStore();
    logs = new InMemoryUserAppLogStore();
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@acme.test',
      role: 'owner',
    });
    http = createServer(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: controlPlane,
        deployGate: {
          authorize: () =>
            Promise.resolve({
              ok: true,
              identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
            }),
        },
        userAppLogStore: logs,
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('records a deployment-lifecycle log and returns it tenant-scoped', async () => {
    const deployed = await deploy('acme', 'hello');
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const live = body.events.find((e) => String(e.message).includes('deployment'));
    expect(live).toBeDefined();
    expect(live?.level).toBe('info');
    expect(live?.deploymentId).toBe(deployed.deploymentId);
    // No secret/token/manifest material leaks into the logs payload.
    expect(JSON.stringify(body)).not.toContain('manifestVersion');
  });

  it('honors a bounded limit', async () => {
    await deploy('acme', 'hello');
    await deploy('acme', 'hello');
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs?limit=9999`);
    expect(res.status).toBe(400);
  });

  it('forbids reading another tenant the caller does not belong to', async () => {
    const res = await fetch(`${base}/v1/orgs/globex/apps/hello/envs/prod/logs`);
    expect(res.status).toBe(403);
  });

  it('filters by level, search substring, and time range (Stage D)', async () => {
    await logs.emit({
      level: 'info',
      message: 'runtime ready',
      org: 'acme',
      app: 'hello',
      env: 'prod',
    });
    await logs.emit({
      level: 'error',
      message: 'connector boom: upstream 500',
      org: 'acme',
      app: 'hello',
      env: 'prod',
    });
    await logs.emit({
      level: 'warn',
      message: 'OPENAI_API_KEY missing',
      org: 'acme',
      app: 'hello',
      env: 'prod',
    });

    const byLevel = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs?level=error`);
    expect(byLevel.status).toBe(200);
    const levelBody = (await byLevel.json()) as { events: readonly { level: string }[] };
    expect(levelBody.events).toHaveLength(1);
    expect(levelBody.events[0]?.level).toBe('error');

    // Case-insensitive plain substring — never interpreted as a regex.
    const bySearch = await fetch(
      `${base}/v1/orgs/acme/apps/hello/envs/prod/logs?search=${encodeURIComponent('BOOM')}`,
    );
    const searchBody = (await bySearch.json()) as { events: readonly { message: string }[] };
    expect(searchBody.events).toHaveLength(1);
    expect(searchBody.events[0]?.message).toContain('connector boom');

    const futureOnly = await fetch(
      `${base}/v1/orgs/acme/apps/hello/envs/prod/logs?since=2099-01-01T00:00:00Z`,
    );
    expect(((await futureOnly.json()) as { events: readonly unknown[] }).events).toHaveLength(0);
  });

  it('normalizes a parseable non-ISO timestamp instead of comparing it raw', async () => {
    await logs.emit({ level: 'info', message: 'ready', org: 'acme', app: 'hello', env: 'prod' });
    // RFC 2822 passes Date.parse but raw-string compare against ISO createdAt would match nothing
    // ("Sat, ..." > "2026-..." lexicographically); normalization to toISOString() makes it work.
    const res = await fetch(
      `${base}/v1/orgs/acme/apps/hello/envs/prod/logs?since=${encodeURIComponent('Sat, 01 Jan 2000 00:00:00 GMT')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: readonly unknown[] };
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown level and an unparseable timestamp with 400', async () => {
    const badLevel = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs?level=verbose`);
    expect(badLevel.status).toBe(400);
    const badSince = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/logs?since=garbage`);
    expect(badSince.status).toBe(400);
  });

  async function deploy(org: string, app: string): Promise<{ deploymentId: string }> {
    const res = await fetch(`${base}/v1/orgs/${org}/apps/${app}/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: HELLO, accessMode: 'public' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { deploymentId: string };
  }
});
