import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  ServerRegistry,
} from '../src/index.js';
import { createAcmeControlPlane } from './control-plane-test-helpers.js';

const HELLO = JSON.stringify({
  manifestVersion: '1',
  server: { name: 'hello', version: '1.0.0', title: 'Hello' },
  tools: [
    {
      name: 'greet',
      description: 'Greet someone.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      fulfilment: {
        steps: [{ id: 'build', map: { message: 'Hello, ${input.name}!' } }],
        output: { message: '${steps.build.message}' },
      },
    },
  ],
  resources: [
    {
      uri: 'docs://hello',
      name: 'hello_docs',
      fulfilment: { steps: [], output: { value: 'Hello docs' } },
    },
  ],
  prompts: [
    {
      name: 'brief',
      description: 'Brief prompt',
      arguments: [{ name: 'topic', description: 'Topic', required: true }],
      fulfilment: { steps: [], output: { value: 'Brief: ${input.topic}' } },
    },
  ],
});

const verifier: GoogleIdTokenVerifier = {
  verify: (token, audience) => {
    if (audience !== 'google-client' || token !== 'admin-token') throw new Error('bad token');
    return Promise.resolve({ subject: 'admin-sub', email: 'admin@noodleseed.com' });
  },
};

async function startAuthenticated() {
  const controlPlane = await createAcmeControlPlane();
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      logger: { debug() {}, info: vi.fn(), warn() {}, error() {} },
      controlPlaneGoogleClientId: 'google-client',
      deployGate: new GoogleControlPlaneGate({
        audience: 'google-client',
        admins: ['admin@noodleseed.com'],
        verifier,
      }),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('hosted deployment diagnostics', () => {
  const auth = { authorization: 'Bearer admin-token' };

  it('inspects active deployment metadata without exposing manifest source', async () => {
    const s = await startAuthenticated();
    try {
      const deployed = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO }),
      });
      const dep = await deployed.json();
      expect(deployed.status, JSON.stringify(dep)).toBe(201);

      const inspected = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/inspect`, {
        headers: auth,
      });
      expect(inspected.status).toBe(200);
      const body = await inspected.json();
      expect(body).toMatchObject({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'prod' },
        deployment: {
          deploymentId: dep.deploymentId,
          endpointUrl: dep.url,
          accessMode: 'owner-only',
          serverName: 'hello',
        },
        health: { state: 'ready', missingSecrets: [] },
        surface: {
          tools: [{ name: 'greet' }],
          resources: [{ uri: 'docs://hello', name: 'hello_docs' }],
          prompts: [{ name: 'brief' }],
          widgets: [],
          widgetLinkedTools: [],
          appOnlyTools: [],
          compatibility: { mcpApps: 'pass', chatgpt: 'unverified', claude: 'unverified' },
        },
        findings: [],
      });
      const json = JSON.stringify(body);
      expect(json).not.toContain('fulfilment');
      expect(json).not.toContain('${input.name}');
    } finally {
      await s.close();
    }
  });

  it('smoke returns actionable external commands and requires tenant authorization', async () => {
    const s = await startAuthenticated();
    try {
      const deployed = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(deployed.status, JSON.stringify(await deployed.json())).toBe(201);

      const unauthenticated = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/smoke`, {
        method: 'POST',
      });
      expect(unauthenticated.status).toBe(401);

      const smoke = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/smoke`, {
        method: 'POST',
        headers: auth,
      });
      expect(smoke.status).toBe(200);
      const body = await smoke.json();
      expect(body.ok).toBe(true);
      expect(body.checks.map((check: { level: string; name: string }) => check)).toEqual([
        { level: 'PASS', name: 'Deployment', message: 'active deployment found' },
        { level: 'PASS', name: 'Config', message: 'all required managed config is present' },
        { level: 'PASS', name: 'Surface', message: '1 tools, 1 resources, 1 prompts, 0 widgets' },
        { level: 'PASS', name: 'MCP Apps', message: 'widget metadata is structurally ready' },
      ]);
      expect(body.external.inspector).toContain('@modelcontextprotocol/inspector');
      expect(body.external.mcpjam).toContain('@mcpjam/cli@latest');
      expect(JSON.stringify(body)).not.toContain('manifestVersion');
    } finally {
      await s.close();
    }
  });

  it('inspect reports missing managed config by name only', async () => {
    const s = await startAuthenticated();
    const connectors = `
connectors:
  - id: secure_api
    version: 1.0.0
    http:
      baseUrl: http://127.0.0.1:1
      allowedOrigins: [ http://127.0.0.1:1 ]
      auth: { kind: bearer, secret: api_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output: {}
        response: {}
`;
    try {
      const secret = await fetch(`${s.base}/v1/orgs/acme/apps/secure/envs/prod/secrets/api_token`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ value: 'SECRET_VALUE' }),
      });
      expect(secret.status).toBe(200);
      const deployed = await fetch(`${s.base}/v1/orgs/acme/apps/secure/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO, connectors }),
      });
      expect(deployed.status, JSON.stringify(await deployed.json())).toBe(201);
      const deleted = await fetch(
        `${s.base}/v1/orgs/acme/apps/secure/envs/prod/secrets/api_token`,
        {
          method: 'DELETE',
          headers: auth,
        },
      );
      expect(deleted.status).toBe(204);

      const inspected = await fetch(`${s.base}/v1/orgs/acme/apps/secure/envs/prod/inspect`, {
        headers: auth,
      });
      expect(inspected.status).toBe(200);
      const body = await inspected.json();
      expect(body.health).toEqual({ state: 'missing-config', missingSecrets: ['api_token'] });
      expect(JSON.stringify(body)).not.toContain('SECRET_VALUE');
    } finally {
      await s.close();
    }
  });
});
