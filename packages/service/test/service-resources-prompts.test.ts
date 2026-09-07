import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { RECOMMENDED_COMPILED_WIDGET_HTML_BYTES } from '@noodle-borg/compiler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceHandler, InMemoryConfigStore, ServerRegistry } from '../src/index.js';
import { createAcmeControlPlane } from './control-plane-test-helpers.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_TOKEN = 'OWNER';
const MEMBER_TOKEN = 'MEMBER';
const ADMIN_TOKEN = 'ADMIN';
const NO_AUTH = '__NO_AUTH__';

let http: Server;
let base: string;
let configStore: InMemoryConfigStore;

beforeEach(async () => {
  configStore = new InMemoryConfigStore();
  const controlPlane = await createAcmeControlPlane();
  http = createServer(
    createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
      configStore,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) => {
        if (token === OWNER_TOKEN) return Promise.resolve({ caller: { subject: 'owner-sub' } });
        if (token === MEMBER_TOKEN) {
          return Promise.resolve({
            caller: {
              subject: 'owner-sub',
              roles: ['support_agent'],
              scopes: ['cases:read'],
            },
          });
        }
        if (token === ADMIN_TOKEN) {
          return Promise.resolve({
            caller: {
              subject: 'owner-sub',
              roles: ['support_admin'],
              scopes: ['cases:read', 'cases:write'],
            },
          });
        }
        return Promise.resolve(null);
      },
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function tenantDeployUrl(baseUrl: string, app = 'hello', env = 'prod'): string {
  return `${baseUrl}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`;
}

function authHeaders(key: string | undefined): Record<string, string> {
  if (key === NO_AUTH) return {};
  return { authorization: `Bearer ${key ?? OWNER_TOKEN}` };
}

describe('deployed resources & prompts over the MCP wire', () => {
  const RP_MANIFEST = JSON.stringify({
    manifestVersion: '1',
    server: { name: 'rp_demo', version: '1.0.0', title: 'RP Demo' },
    tools: [
      {
        name: 'noop',
        description: 'A pure tool.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: 'true' } },
      },
    ],
    resources: [
      {
        name: 'welcome',
        uri: 'docs://welcome',
        mimeType: 'text/markdown',
        fulfilment: { steps: [], output: { value: '# Welcome' } },
      },
      {
        name: 'item',
        uri: 'items://{id}',
        fulfilment: { steps: [], output: { value: 'Item ${input.id}' } },
      },
    ],
    prompts: [
      {
        name: 'greet',
        arguments: [{ name: 'who', required: true }],
        fulfilment: { steps: [], output: { value: 'Hello ${input.who}' } },
      },
    ],
  });

  const GUIDED_MANIFEST = readFileSync(
    join(import.meta.dirname, 'fixtures/app-package-guided-v2.yaml'),
    'utf8',
  );

  const PERMISSIONED_GUIDED_MANIFEST = JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'permissioned_guided',
      title: 'Permissioned Guided',
      version: '1.0.0',
      agentGuide: {
        description: 'Investigate and resolve support cases.',
        useWhen: ['A customer asks about an existing support case.'],
        workflows: [
          {
            id: 'review_cases',
            title: 'Review cases',
            steps: [{ capability: { kind: 'tool', name: 'list_cases' } }],
          },
          {
            id: 'close_case',
            title: 'Close a case',
            steps: [
              { capability: { kind: 'tool', name: 'list_cases' } },
              { capability: { kind: 'tool', name: 'close_case' } },
            ],
          },
          {
            id: 'refresh_widget',
            title: 'Refresh the widget',
            steps: [{ capability: { kind: 'tool', name: 'widget_refresh' } }],
          },
        ],
        boundaries: ['Never report a write before it succeeds.'],
        examples: [
          { prompt: 'Which cases are open?', workflow: 'review_cases' },
          { prompt: 'Close case 42.', workflow: 'close_case' },
          { prompt: 'Refresh the UI.', workflow: 'refresh_widget' },
        ],
      },
    },
    tools: [
      {
        name: 'list_cases',
        description: 'List support cases.',
        authorization: {
          requiredScopes: ['cases:read'],
          allowedRoles: ['support_agent', 'support_admin'],
        },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { cases: [] } },
      },
      {
        name: 'close_case',
        description: 'Close one support case.',
        authorization: {
          requiredScopes: ['cases:write'],
          allowedRoles: ['support_admin'],
        },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { closed: true } },
      },
      {
        name: 'widget_refresh',
        description: 'Refresh widget state.',
        visibility: ['app'],
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { refreshed: true } },
      },
    ],
  });

  async function deploy(
    manifest: string,
    connectors?: string,
  ): Promise<{ url: string; key?: string }> {
    const res = await fetch(tenantDeployUrl(base, 'resources'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest, ...(connectors ? { connectors } : {}) }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`deploy failed: ${JSON.stringify(json)}`);
    return { url: json.url as string };
  }

  async function rpc(
    url: string,
    method: string,
    params: unknown,
    key?: string,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...authHeaders(key) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
    });
    return (await res.json()).result;
  }

  async function modernRpc(
    url: string,
    method: string,
    params: Record<string, unknown> = {},
    token: string | false = OWNER_TOKEN,
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const headers = new Headers({
      ...JSON_HEADERS,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(token === false ? {} : authHeaders(token)),
    });
    if (method === 'resources/read' && typeof params.uri === 'string') {
      headers.set('mcp-name', params.uri);
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function firstSkillEntry(body: Record<string, unknown>): {
    readonly uri: string;
    readonly resources: readonly { readonly uri: string; readonly digest: string }[];
  } {
    const result = body.result as { readonly skills?: readonly unknown[] } | undefined;
    const entry = result?.skills?.[0] as
      | {
          readonly uri?: unknown;
          readonly resources?: readonly { readonly uri: string; readonly digest: string }[];
        }
      | undefined;
    if (typeof entry?.uri !== 'string' || entry.resources === undefined) {
      throw new Error('expected one skill entry');
    }
    return { uri: entry.uri, resources: entry.resources };
  }

  async function skillText(url: string, uri: string, token: string): Promise<string> {
    const response = await modernRpc(url, 'resources/read', { uri }, token);
    const result = response.body.result as
      | { readonly contents?: readonly { readonly text?: unknown }[] }
      | undefined;
    const text = result?.contents?.[0]?.text;
    if (typeof text !== 'string') throw new Error(`expected text resource ${uri}`);
    return text;
  }

  function sha256Digest(content: string): string {
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  }

  it('serves resources/list, resources/read (fixed + templated), and prompts/get end-to-end', async () => {
    const { url, key } = await deploy(RP_MANIFEST);

    const list = await rpc(url, 'resources/list', {}, key);
    expect((list.resources as { uri: string }[]).map((r) => r.uri)).toEqual(['docs://welcome']);

    const templates = await rpc(url, 'resources/templates/list', {}, key);
    expect((templates.resourceTemplates as { uriTemplate: string }[])[0]?.uriTemplate).toBe(
      'items://{id}',
    );

    const welcome = await rpc(url, 'resources/read', { uri: 'docs://welcome' }, key);
    expect((welcome.contents as { text: string }[])[0]?.text).toBe('# Welcome');

    const item = await rpc(url, 'resources/read', { uri: 'items://7' }, key);
    expect((item.contents as { text: string }[])[0]?.text).toBe('Item 7');

    const prompt = await rpc(url, 'prompts/get', { name: 'greet', arguments: { who: 'Ada' } }, key);
    expect((prompt.messages as { content: { text: string } }[])[0]?.content.text).toBe('Hello Ada');
  });

  it('serves one authenticated deployment-bound skill with digest-consistent files', async () => {
    const { url } = await deploy(GUIDED_MANIFEST);

    const unauthorized = await modernRpc(url, 'skills/list', {}, false);
    expect(unauthorized.status).toBe(401);
    expect(JSON.stringify(unauthorized.body)).not.toContain('skill://guided/');

    const discovery = await modernRpc(url, 'server/discover');
    expect(discovery.body).toMatchObject({
      result: {
        capabilities: {
          resources: {},
          extensions: { 'io.modelcontextprotocol/skills': {} },
        },
      },
    });

    const listed = await modernRpc(url, 'skills/list');
    const entry = ((listed.body.result as { skills: unknown[] }).skills ?? [])[0] as {
      readonly uri: string;
      readonly resources: readonly { readonly uri: string; readonly digest: string }[];
    };
    expect(entry.uri).toBe('skill://guided/SKILL.md');
    expect(entry.resources).toHaveLength(2);

    const fetched = await modernRpc(url, 'skills/get', { uri: entry.uri });
    expect((fetched.body.result as { skill: unknown }).skill).toEqual(entry);
    for (const resource of entry.resources) {
      const read = await modernRpc(url, 'resources/read', { uri: resource.uri });
      const content = ((read.body.result as { contents: { text: string }[] }).contents ?? [])[0]
        ?.text;
      expect(content).toBeTypeOf('string');
      expect(
        `sha256:${createHash('sha256')
          .update(content ?? '')
          .digest('hex')}`,
      ).toBe(resource.digest);
    }
  });

  it('serves different complete skills and digests to authorized members and administrators', async () => {
    const { url } = await deploy(PERMISSIONED_GUIDED_MANIFEST);
    const memberEntry = firstSkillEntry(
      (await modernRpc(url, 'skills/list', {}, MEMBER_TOKEN)).body,
    );
    const adminEntry = firstSkillEntry((await modernRpc(url, 'skills/list', {}, ADMIN_TOKEN)).body);
    const memberSkill = await skillText(url, memberEntry.uri, MEMBER_TOKEN);
    const memberReference = await skillText(url, memberEntry.resources[1]?.uri ?? '', MEMBER_TOKEN);
    const adminSkill = await skillText(url, adminEntry.uri, ADMIN_TOKEN);
    const adminReference = await skillText(url, adminEntry.resources[1]?.uri ?? '', ADMIN_TOKEN);

    expect(memberSkill).toContain('Review cases');
    expect(memberSkill).not.toContain('Close a case');
    expect(memberSkill).not.toContain('Refresh the widget');
    expect(memberReference).toContain('list_cases');
    expect(memberReference).not.toContain('close_case');
    expect(memberReference).not.toContain('widget_refresh');

    expect(adminSkill).toContain('Review cases');
    expect(adminSkill).toContain('Close a case');
    expect(adminSkill).not.toContain('Refresh the widget');
    expect(adminReference).toContain('list_cases');
    expect(adminReference).toContain('close_case');
    expect(adminReference).not.toContain('widget_refresh');

    expect(memberEntry.resources.map((resource) => resource.digest)).not.toEqual(
      adminEntry.resources.map((resource) => resource.digest),
    );
    expect(memberEntry.resources).toEqual([
      { uri: memberEntry.uri, digest: sha256Digest(memberSkill) },
      { uri: memberEntry.resources[1]?.uri, digest: sha256Digest(memberReference) },
    ]);
    expect(adminEntry.resources).toEqual([
      { uri: adminEntry.uri, digest: sha256Digest(adminSkill) },
      { uri: adminEntry.resources[1]?.uri, digest: sha256Digest(adminReference) },
    ]);
  });

  it('deploys and serves a compiled widget larger than the 1 MiB recommendation without truncation', async () => {
    const payload = 'x'.repeat(RECOMMENDED_COMPILED_WIDGET_HTML_BYTES + 1);
    const manifest = JSON.stringify({
      manifestVersion: '1',
      server: { name: 'large_widget', version: '1.0.0', title: 'Large Widget' },
      tools: [
        {
          name: 'open_widget',
          description: 'Open the large widget.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { value: 'ready' } },
        },
      ],
      widgets: [
        {
          name: 'dashboard',
          tool: 'open_widget',
          view: {
            component: 'Dashboard',
            entry: './views/Dashboard.tsx',
            compiledHtml: `<!doctype html><html><body>${payload}</body></html>`,
          },
        },
      ],
    });
    const { url, key } = await deploy(manifest);

    const resource = await rpc(url, 'resources/read', { uri: 'ui://large_widget/dashboard' }, key);
    const text = (resource.contents as { text: string }[])[0]?.text ?? '';
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(RECOMMENDED_COMPILED_WIDGET_HTML_BYTES);
    expect(text).toContain(payload);
  });

  it('serves connector-backed resources and prompts end-to-end after deploy', async () => {
    const backing = createServer((req, res) => {
      const m = /^\/items\/(\w+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: m[1], status: 'open' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
    const { port } = backing.address() as AddressInfo;
    const backingUrl = `http://127.0.0.1:${port}`;
    try {
      const manifest = JSON.stringify({
        manifestVersion: '1',
        server: { name: 'rp_connector_demo', version: '1.0.0', title: 'RP Connector Demo' },
        connectors: { items: { id: 'items_api', version: '1.0.0' } },
        tools: [
          {
            name: 'noop',
            description: 'A pure tool.',
            inputSchema: { type: 'object' },
            fulfilment: { steps: [], output: { ok: 'true' } },
          },
        ],
        resources: [
          {
            name: 'item',
            uri: 'items://{id}',
            fulfilment: {
              steps: [{ id: 'get', use: 'items.get_item', args: { id: '${input.id}' } }],
              output: { value: 'Item ${steps.get.status}: ${steps.get.id}' },
            },
          },
        ],
        prompts: [
          {
            name: 'summarize_item',
            arguments: [{ name: 'id', required: true }],
            fulfilment: {
              steps: [{ id: 'get', use: 'items.get_item', args: { id: '${input.id}' } }],
              output: { value: 'Summarize item ${steps.get.id} (${steps.get.status})' },
            },
          },
        ],
      });
      const connectors = `
connectors:
  - id: items_api
    version: 1.0.0
    http:
      baseUrl: ${backingUrl}
      allowedOrigins: [ ${backingUrl} ]
    operations:
      get_item:
        type: read
        method: GET
        path: /items/{id}
        input:
          type: object
          properties:
            id: { type: string }
          required: [id]
          additionalProperties: false
        output:
          type: object
          properties:
            id: { type: string }
            status: { type: string }
          additionalProperties: false
        response:
          id: \${response.id}
          status: \${response.status}
`;
      const { url, key } = await deploy(manifest, connectors);
      const item = await rpc(url, 'resources/read', { uri: 'items://A1' }, key);
      expect((item.contents as { text: string }[])[0]?.text).toBe('Item open: A1');

      const prompt = await rpc(
        url,
        'prompts/get',
        { name: 'summarize_item', arguments: { id: 'B2' } },
        key,
      );
      expect((prompt.messages as { content: { text: string } }[])[0]?.content.text).toBe(
        'Summarize item B2 (open)',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        backing.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
