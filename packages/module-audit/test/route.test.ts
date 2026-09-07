import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditStore, ModuleRouteContext } from '@noodle-borg/module';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuditEventsRoute } from '../src/index.js';

let servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers = [];
});

describe('audit events route', () => {
  it('requires control-plane authentication', async () => {
    const base = await listen(store(), {});
    const res = await fetch(`${base}/v1/audit/events?org=acme`);

    expect(res.status).toBe(401);
  });

  it('lists tenant-scoped audit events for a super-admin', async () => {
    const seen: unknown[] = [];
    const base = await listen(
      store({
        list: async (filter) => {
          seen.push(filter);
          return [
            {
              id: '00000000-0000-0000-0000-000000000001',
              schemaVersion: 1,
              eventType: 'deploy.accepted',
              org: 'acme',
              createdAt: '2026-06-13T00:00:00.000Z',
              details: { name: 'API_KEY', leak: '[redacted]' },
            },
          ];
        },
      }),
      {
        controlPlane: {
          authorize: () => ({
            ok: true,
            identity: {
              subject: 'admin-sub',
              email: 'admin@noodleseed.com',
              superAdmin: true,
            },
          }),
        },
      },
    );

    const res = await fetch(
      `${base}/v1/audit/events?org=acme&app=hello&env=prod&eventType=deploy.accepted&limit=1`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { org: 'acme', app: 'hello', env: 'prod', eventType: 'deploy.accepted', limit: 1 },
    ]);
    expect(body.events[0].details).toEqual({ name: 'API_KEY', leak: '[redacted]' });
  });

  it('rejects non-super-admin identities', async () => {
    const base = await listen(store(), {
      controlPlane: {
        authorize: () => ({
          ok: true,
          identity: { subject: 'user-sub', email: 'user@example.com', superAdmin: false },
        }),
      },
    });

    const res = await fetch(`${base}/v1/audit/events?org=acme`);

    expect(res.status).toBe(403);
  });
});

function store(overrides: Partial<AuditStore> = {}): AuditStore {
  return {
    emit: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

async function listen(
  storeForRoute: AuditStore,
  ctx: Partial<ModuleRouteContext>,
): Promise<string> {
  const route = createAuditEventsRoute(storeForRoute);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!route.match(req.method, url)) {
      res.writeHead(404).end();
      return;
    }
    void route.handle(req, res, {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ...ctx,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
