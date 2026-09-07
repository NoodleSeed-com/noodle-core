import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { AlertRuleResponseSchema, AlertRulesListResponseSchema } from '@noodle-borg/wire-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryAlertRuleStore,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * Route tests for the analytics alerting surface (E2): `GET`/`POST .../alerts`,
 * `DELETE .../alerts/{id}`, and `POST .../alerts/{id}/test`. Reads are org-membership gated;
 * mutations are owner-gated and audited; the webhook URL is accepted once at create and never
 * appears in any response afterwards (the strict Zod contract has no field for it).
 */

const SECRET = 'secret-route-token-xyz';
let server: Server;
let base: string;
let hookServer: Server;
let hookPort: number;
let hookRequests: { url?: string; body?: string }[] = [];
const alertRules = new InMemoryAlertRuleStore();
const audit = new InMemoryAuditStore();

const gate = {
  authorize: (req: { headers: Record<string, string | string[] | undefined> }) => {
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
    if (token === 'owner-token') {
      return Promise.resolve({
        ok: true as const,
        identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
      });
    }
    if (token === 'member-token') {
      return Promise.resolve({
        ok: true as const,
        identity: { subject: 'member-sub', email: 'dev@acme.test', superAdmin: false },
      });
    }
    return Promise.resolve({ ok: false as const, status: 401 as const, message: 'unauthorized' });
  },
};

beforeAll(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'member-sub',
    email: 'dev@acme.test',
    role: 'developer',
  });

  hookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hookRequests.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hookPort = (hookServer.address() as AddressInfo).port;

  const handler = createServiceHandler(new ServerRegistry(), {
    controlPlaneStore: controlPlane,
    alertRuleStore: alertRules,
    audit,
    alertWebhookAllowLoopback: true,
    deployGate: gate,
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve) => {
    hookServer.close(() => resolve());
    hookServer.closeAllConnections?.();
  });
});

const ALERTS = '/v1/orgs/acme/apps/support/envs/prod/alerts';

function call(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'error spike',
    metric: 'error_share',
    threshold: 0.2,
    windowMinutes: 15,
    webhookUrl: `https://hooks.example.com/T0/${SECRET}`,
    ...overrides,
  };
}

describe('alert rule routes: authorization', () => {
  it('rejects a missing token with 401 on every route', async () => {
    for (const [method, path] of [
      ['GET', ALERTS],
      ['POST', ALERTS],
      ['DELETE', `${ALERTS}/11111111-2222-4333-8444-555555555555`],
      ['POST', `${ALERTS}/11111111-2222-4333-8444-555555555555/test`],
    ] as const) {
      const res = await call(method, path, undefined, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a non-member with 403 (tenant isolation)', async () => {
    const res = await call('GET', '/v1/orgs/globex/apps/x/envs/prod/alerts', 'owner-token');
    expect(res.status).toBe(403);
  });

  it('lets an ordinary member list but not mutate', async () => {
    const list = await call('GET', ALERTS, 'member-token');
    expect(list.status).toBe(200);
    const create = await call('POST', ALERTS, 'member-token', createBody());
    expect(create.status).toBe(403);
    const del = await call(
      'DELETE',
      `${ALERTS}/11111111-2222-4333-8444-555555555555`,
      'member-token',
    );
    expect(del.status).toBe(403);
    const test = await call(
      'POST',
      `${ALERTS}/11111111-2222-4333-8444-555555555555/test`,
      'member-token',
      {},
    );
    expect(test.status).toBe(403);
  });
});

describe('alert rule routes: validation', () => {
  it('rejects invalid create payloads with 400', async () => {
    const cases: Record<string, unknown>[] = [
      createBody({ metric: 'latency' }),
      createBody({ threshold: '0.2' }),
      createBody({ threshold: -1 }),
      createBody({ windowMinutes: 7 }),
      createBody({ cooldownMinutes: 0 }),
      createBody({ name: 'x'.repeat(200) }),
      createBody({ webhookUrl: undefined }),
      createBody({ webhookUrl: 'not a url' }),
      createBody({ webhookUrl: 'http://evil.example.com/x' }),
      createBody({ webhookUrl: 'https://user:pass@example.com/x' }),
      createBody({ webhookUrl: 'https://10.0.0.1/x' }),
      createBody({ webhookUrl: 'https://169.254.169.254/x' }),
    ];
    for (const body of cases) {
      const res = await call('POST', ALERTS, 'owner-token', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects loopback webhook targets when the carve-out is off (production posture)', async () => {
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@acme.test',
      role: 'owner',
    });
    const handler = createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      alertRuleStore: new InMemoryAlertRuleStore(),
      deployGate: gate,
    });
    const strict = createServer(handler);
    await new Promise<void>((resolve) => strict.listen(0, '127.0.0.1', resolve));
    const strictBase = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${strictBase}${ALERTS}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
        body: JSON.stringify(createBody({ webhookUrl: 'http://127.0.0.1:9999/hook' })),
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) =>
        strict.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

describe('alert rule routes: CRUD round-trip and redaction', () => {
  it('creates, lists, and deletes a rule without ever echoing the webhook URL', async () => {
    const created = await call('POST', ALERTS, 'owner-token', createBody());
    expect(created.status).toBe(200);
    const createdText = await created.text();
    expect(createdText).not.toContain(SECRET);
    const createdBody = AlertRuleResponseSchema.parse(JSON.parse(createdText));
    expect(createdBody.data.metric).toBe('error_share');
    expect(createdBody.data.comparison).toBe('>=');
    expect(createdBody.data.webhook).toContain('https://hooks.example.com');
    expect(createdBody.data.breaching).toBe(false);

    const listed = await call('GET', ALERTS, 'owner-token');
    const listedText = await listed.text();
    expect(listedText).not.toContain(SECRET);
    const listBody = AlertRulesListResponseSchema.parse(JSON.parse(listedText));
    expect(listBody.data.rules.map((r) => r.id)).toContain(createdBody.data.id);

    const deleted = await call('DELETE', `${ALERTS}/${createdBody.data.id}`, 'owner-token');
    expect(deleted.status).toBe(200);
    const afterDelete = AlertRulesListResponseSchema.parse(
      JSON.parse(await (await call('GET', ALERTS, 'owner-token')).text()),
    );
    expect(afterDelete.data.rules.map((r) => r.id)).not.toContain(createdBody.data.id);

    const deleteAgain = await call('DELETE', `${ALERTS}/${createdBody.data.id}`, 'owner-token');
    expect(deleteAgain.status).toBe(404);
  });

  it('caps rules per environment with 409', async () => {
    const capPath = '/v1/orgs/acme/apps/support/envs/cap/alerts';
    for (let i = 0; i < 20; i++) {
      const res = await call('POST', capPath, 'owner-token', createBody({ name: `rule ${i}` }));
      expect(res.status).toBe(200);
    }
    const overflow = await call('POST', capPath, 'owner-token', createBody({ name: 'overflow' }));
    expect(overflow.status).toBe(409);
  });
});

describe('alert rule routes: test-fire', () => {
  it('sends the synthetic test payload through the guarded delivery path', async () => {
    hookRequests = [];
    const created = AlertRuleResponseSchema.parse(
      JSON.parse(
        await (
          await call(
            'POST',
            ALERTS,
            'owner-token',
            createBody({ webhookUrl: `http://127.0.0.1:${hookPort}/hook/${SECRET}` }),
          )
        ).text(),
      ),
    );
    const res = await call('POST', `${ALERTS}/${created.data.id}/test`, 'owner-token', {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as {
      ok: boolean;
      data: { delivery: { delivered: boolean; status?: number } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.delivery).toEqual({ delivered: true, status: 200 });
    expect(hookRequests).toHaveLength(1);
    const payload = JSON.parse(hookRequests[0]?.body ?? '{}') as {
      schemaVersion: number;
      event: string;
      org: string;
      rule: { id: string };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.event).toBe('test');
    expect(payload.org).toBe('acme');
    expect(payload.rule.id).toBe(created.data.id);

    await call('DELETE', `${ALERTS}/${created.data.id}`, 'owner-token');
  });

  it('404s an unknown or malformed rule id', async () => {
    const unknown = await call(
      'POST',
      `${ALERTS}/11111111-2222-4333-8444-555555555555/test`,
      'owner-token',
      {},
    );
    expect(unknown.status).toBe(404);
    const malformed = await call('POST', `${ALERTS}/not-a-uuid/test`, 'owner-token', {});
    expect(malformed.status).toBe(404);
  });

  it('treats a malformed percent-escape id as no-match instead of throwing (URIError guard)', async () => {
    // `%zz` makes decodeURIComponent throw; the parser must swallow it, not crash the process.
    for (const [method, path] of [
      ['DELETE', `${ALERTS}/%zz`],
      ['POST', `${ALERTS}/%zz/test`],
    ] as const) {
      const res = await call(method, path, 'owner-token', method === 'POST' ? {} : undefined);
      expect(res.status).toBe(404);
    }
    // The server is still alive and serving.
    const alive = await call('GET', ALERTS, 'owner-token');
    expect(alive.status).toBe(200);
  });
});

describe('alert rule routes: audit trail', () => {
  it('audits create/delete/test-fire with scalar details and no webhook URL', async () => {
    const events = await audit.list({ org: 'acme' });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('alert.rule.created');
    expect(types).toContain('alert.rule.deleted');
    expect(types).toContain('alert.rule.test_fired');
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('hooks.example.com');
  });
});

describe('alert contract fixtures parse against the Zod schemas', () => {
  const contractDir = join(import.meta.dirname, '..', '..', '..', 'contract', 'v1');

  function readFixture(name: string): unknown {
    return JSON.parse(readFileSync(join(contractDir, name), 'utf8'));
  }

  it('alert-rule-response.json parses as an AlertRuleResponse', () => {
    expect(() =>
      AlertRuleResponseSchema.parse(readFixture('alert-rule-response.json')),
    ).not.toThrow();
  });

  it('alert-rules-list-response.json parses as an AlertRulesListResponse', () => {
    expect(() =>
      AlertRulesListResponseSchema.parse(readFixture('alert-rules-list-response.json')),
    ).not.toThrow();
  });
});
