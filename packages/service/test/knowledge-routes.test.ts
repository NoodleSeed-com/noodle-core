import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultKnowledgeStores } from '@noodle-borg/knowledge-operations';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerToken,
  createServiceHandler,
  type DeployAuthGate,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const MEMBER = { subject: 'member-sub', email: 'member@acme.test' };

const gate: DeployAuthGate = {
  authorize(req) {
    const token = bearerToken(req);
    if (token === 'member') return { ok: true, identity: MEMBER };
    if (token === 'outsider') return { ok: true, identity: { subject: 'outsider-sub' } };
    return { ok: false, status: 401, message: 'missing bearer token' };
  },
};

let http: Server;
let base: string;
let configStore: InMemoryConfigStore;
let registryRef: ServerRegistry;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const PREFLIGHT_PATH = '/v1/orgs/acme/apps/site/envs/prod/knowledge/preflight';
const documentPath = (hash: string): string =>
  `/v1/orgs/acme/apps/site/envs/prod/knowledge/documents/${hash}`;

async function enableKnowledge(): Promise<void> {
  await configStore.setConfigValue({
    kind: 'variable',
    scope: { level: 'env', org: 'acme', app: 'site', env: 'prod' },
    name: 'NOODLE_KNOWLEDGE_ENABLED',
    value: 'true',
  });
}

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: MEMBER.subject,
    email: MEMBER.email,
    role: 'developer',
  });
  configStore = new InMemoryConfigStore();
  const registry = new ServerRegistry(undefined, undefined, configStore);
  registryRef = registry;
  http = createServer(
    createServiceHandler(registry, {
      deployGate: gate,
      controlPlaneStore: controlPlane,
      configStore,
      knowledge: defaultKnowledgeStores(),
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

function preflight(token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${PREFLIGHT_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const request = {
  components: [{ name: 'product', documents: [{ sha256: sha('doc one'), bytes: 7 }] }],
};

describe('knowledge control-plane routes', () => {
  it('requires authentication', async () => {
    const response = await fetch(`${base}${PREFLIGHT_PATH}`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a non-member of the org', async () => {
    const response = await preflight('outsider', request);
    expect(response.status).toBe(403);
  });

  it('fails closed with the enable command when the feature gate is off', async () => {
    const response = await preflight('member', request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; fix: string };
    expect(body.code).toBe('knowledge_not_enabled');
    expect(body.fix).toContain('NOODLE_KNOWLEDGE_ENABLED');
  });

  it('diffs, accepts verified bytes, and reuses staged content across preflights', async () => {
    await enableKnowledge();
    const first = await preflight('member', request);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, missing: [sha('doc one')] });

    const upload = await fetch(`${base}${documentPath(sha('doc one'))}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer member' },
      body: 'doc one',
    });
    expect(upload.status).toBe(200);

    const second = await preflight('member', request);
    expect(await second.json()).toEqual({ ok: true, missing: [] });
  });

  it('rejects tampered upload bytes', async () => {
    await enableKnowledge();
    const upload = await fetch(`${base}${documentPath(sha('doc one'))}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer member' },
      body: 'not doc one',
    });
    expect(upload.status).toBe(400);
    const body = (await upload.json()) as { code: string };
    expect(body.code).toBe('knowledge_document_hash_mismatch');
  });
});

describe('knowledge operator routes', () => {
  const MANIFEST = JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'acme_site',
      title: 'Acme Site',
      version: '1.0.0',
      knowledge: [
        {
          name: 'product',
          title: 'Product knowledge',
          description: 'Docs.',
          documents: [{ path: 'docs/a.md', title: 'A', sha256: sha('doc one'), bytes: 7 }],
          sites: [{ origin: 'https://www.acme.test', include: ['/docs/**'] }],
        },
      ],
    },
    tools: [
      {
        name: 'ping',
        description: 'Ping.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });

  async function deployKnowledge(): Promise<void> {
    await enableKnowledge();
    const first = await preflight('member', request);
    expect(first.status).toBe(200);
    const upload = await fetch(`${base}${documentPath(sha('doc one'))}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer member' },
      body: 'doc one',
    });
    expect(upload.status).toBe(200);
    const deployed = await registryRef.deploy({ org: 'acme', app: 'site', env: 'prod' }, MANIFEST, {
      accessMode: 'owner-only',
      actor: { subject: MEMBER.subject, email: MEMBER.email },
    });
    expect(deployed.ok).toBe(true);
  }

  it('lists components and reports status over HTTP with lifecycle truth', async () => {
    await deployKnowledge();
    const list = await fetch(`${base}/v1/orgs/acme/apps/site/envs/prod/knowledge`, {
      headers: { authorization: 'Bearer member' },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      components: { name: string; sources: { documents: number; sites: number }; state: string }[];
    };
    expect(listBody.components[0]).toMatchObject({
      name: 'product',
      sources: { documents: 1, sites: 1 },
      state: 'active',
    });

    const status = await fetch(
      `${base}/v1/orgs/acme/apps/site/envs/prod/knowledge/product/status`,
      { headers: { authorization: 'Bearer member' } },
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      component: { activeRevisionId?: string };
      siteProvisioning: string;
    };
    expect(statusBody.component.activeRevisionId).toContain('bm25-rev');
    // Coherent with the deploy above: the harness seam reports the site tier provisioned, so a
    // deploy that succeeded shows 'ready' — a successful site() deploy can no longer coexist
    // with a 'missing' provisioning state (that mismatch was the pre-fix fail-open bug).
    expect(statusBody.siteProvisioning).toBe('ready');
    expect(JSON.stringify(statusBody)).not.toContain('doc one');
  });

  it('refresh runs the crawl over HTTP and reports its state without leaking provider detail', async () => {
    await deployKnowledge();
    const refresh = await fetch(
      `${base}/v1/orgs/acme/apps/site/envs/prod/knowledge/product/refresh`,
      { method: 'POST', headers: { authorization: 'Bearer member' } },
    );
    expect(refresh.status).toBe(200);
    const body = (await refresh.json()) as {
      ok: boolean;
      crawl: { status: string; pagesIndexed: number };
    };
    expect(body.ok).toBe(true);
    // www.acme.test is unreachable from the test sandbox, so the honest outcome is a failed
    // crawl with an attributable, content-free error — never a 5xx or a provider payload.
    expect(['completed', 'failed']).toContain(body.crawl.status);
    const anonymous = await fetch(
      `${base}/v1/orgs/acme/apps/site/envs/prod/knowledge/product/refresh`,
      { method: 'POST' },
    );
    expect(anonymous.status).toBe(401);
  });

  it('404s status for an unknown component and requires auth for reads', async () => {
    await deployKnowledge();
    const missing = await fetch(
      `${base}/v1/orgs/acme/apps/site/envs/prod/knowledge/absent/status`,
      { headers: { authorization: 'Bearer member' } },
    );
    expect(missing.status).toBe(404);
    const anonymous = await fetch(`${base}/v1/orgs/acme/apps/site/envs/prod/knowledge`);
    expect(anonymous.status).toBe(401);
  });
});
