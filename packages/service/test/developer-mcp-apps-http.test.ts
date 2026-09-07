import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createServiceHandler,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  InMemoryDeveloperGrantStore,
  InMemoryRequestEventStore,
  InMemoryUserAppLogStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

const SUBJECT = 'owner-subject';
const CLIENT_ID = 'apps-client';
const TOKEN = 'apps-token';
const ACCEPT = 'application/json, text/event-stream';
const TARGET = { org: 'acme', app: 'demo', env: 'dev' } as const;

const MANIFEST = `
manifestVersion: "1"
server:
  name: demo
  version: 1.0.0
  title: Demo
tools:
  - name: ping
    description: Return a bounded value.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        ok: true
`;

let http: Server;
let base: string;
let registry: ServerRegistry;
let audit: InMemoryAuditStore;
let previousDeploymentId: string;
let currentDeploymentId: string;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: TARGET.org,
    subject: SUBJECT,
    email: 'owner@acme.example',
    role: 'owner',
  });
  const grants = new InMemoryDeveloperGrantStore({ id: () => 'grant-apps-1' });
  const grant = await grants.getOrCreateActive({
    clientId: CLIENT_ID,
    subject: SUBJECT,
    resource: 'https://cloud.example/developer/mcp',
    capabilities: ['cloud:read', 'deployments:rollback'],
  });
  registry = new ServerRegistry();
  const actor = {
    subject: SUBJECT,
    email: 'owner@acme.example',
    superAdmin: false,
  };
  const previous = await registry.deploy(TARGET, MANIFEST, {
    actor,
    accessMode: 'owner-only',
    ownerSubject: 'oauth-owner-previous',
  });
  const current = await registry.deploy(TARGET, MANIFEST, {
    actor,
    accessMode: 'owner-only',
    ownerSubject: 'oauth-owner-current',
  });
  if (!previous.ok || !current.ok || 'superseded' in previous || 'superseded' in current) {
    throw new Error('failed to assemble deployment history fixture');
  }
  previousDeploymentId = previous.deploymentId;
  currentDeploymentId = current.deploymentId;
  audit = new InMemoryAuditStore({ id: () => 'audit-1' });
  const options: ServiceOptions & { readonly developerMcp: true } = {
    developerMcp: true,
    controlPlaneStore: controlPlane,
    developerGrantStore: grants,
    verifyOwnerToken: async (token, resource) =>
      token === TOKEN && resource.endsWith('/developer/mcp')
        ? {
            caller: {
              subject: SUBJECT,
              email: 'owner@acme.example',
              developerGrantId: grant.id,
              oauthClientId: CLIENT_ID,
            },
          }
        : null,
    userAppLogStore: new InMemoryUserAppLogStore(),
    requestEventStore: new InMemoryRequestEventStore(),
    audit,
    publicBaseUrl: 'https://cloud.example',
    logger: createLogger({ sink: () => undefined }),
  };
  http = createServer(createServiceHandler(registry, options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return fetch(`${base}/developer/mcp`, {
    method: 'POST',
    headers: {
      accept: ACCEPT,
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('Noodle developer MCP Apps over authenticated HTTP', () => {
  it('advertises exact standard and compatibility metadata for linked tools', async () => {
    const response = await rpc(1, 'tools/list');
    const body = await response.json();
    const links = new Map(
      body.result.tools
        .filter((tool: { _meta?: unknown }) => tool._meta !== undefined)
        .map((tool: { name: string; _meta: unknown }) => [tool.name, tool._meta]),
    );

    expect(response.status).toBe(200);
    expect(Object.fromEntries(links)).toEqual({
      inspect_app: widgetMeta('ui://noodle-developer/app-overview/v1'),
      inspect_deployment: widgetMeta('ui://noodle-developer/deployment-detail/v1'),
      get_logs: widgetMeta('ui://noodle-developer/operations/v1'),
      get_metrics: widgetMeta('ui://noodle-developer/analytics/v1'),
      diagnose_app: widgetMeta('ui://noodle-developer/operations/v1'),
      rollback_deployment: widgetMeta('ui://noodle-developer/deployment-detail/v1'),
    });
  });

  it('lists and reads four closed-CSP MCP App resources with one injected bridge', async () => {
    const listed = await (await rpc(2, 'resources/list')).json();
    const widgets = listed.result.resources.filter((resource: { mimeType?: string }) =>
      resource.mimeType?.startsWith('text/html'),
    );

    expect(widgets).toHaveLength(4);
    for (const widget of widgets) {
      expect(widget).toMatchObject({
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        },
      });
      const read = await (await rpc(3, 'resources/read', { uri: widget.uri as string })).json();
      const content = read.result.contents[0];
      expect(content).toMatchObject({
        uri: widget.uri,
        mimeType: 'text/html;profile=mcp-app',
        _meta: widget._meta,
      });
      expect(content.text.match(/<script type="module">/g)).toHaveLength(1);
      expect(content.text.match(/<\/script>/g)).toHaveLength(1);
      expect(content.text).toContain('globalThis.ExtApps');
    }
  });

  it('returns a complete headless deployment view to a client with no UI capability', async () => {
    const initialized = await rpc(4, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'headless-agent', version: '1.0.0' },
    });
    expect(initialized.status).toBe(200);

    const response = await rpc(5, 'tools/call', {
      name: 'inspect_deployment',
      arguments: { org: TARGET.org, deploymentId: currentDeploymentId },
    });
    const body = await response.json();
    expect(body.result).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: {
        ok: true,
        data: {
          target: { app: TARGET.app, env: TARGET.env },
          deployment: {
            deploymentId: currentDeploymentId,
            active: true,
            ownerSubject: 'oauth-owner-current',
          },
          rollbackCandidate: { deploymentId: previousDeploymentId },
          health: expect.any(Object),
          surface: expect.any(Object),
          findings: expect.any(Array),
        },
        meta: { org: TARGET.org, env: TARGET.env },
      },
    });

    const app = await (
      await rpc(51, 'tools/call', {
        name: 'inspect_app',
        arguments: { org: TARGET.org, app: TARGET.app, env: TARGET.env },
      })
    ).json();
    expect(app.result.structuredContent).toMatchObject({
      data: { latest: { ownerSubject: 'oauth-owner-current' } },
    });
  });

  it('routes a widget-equivalent rollback call through the same owner, grant, audit, and registry path', async () => {
    const response = await rpc(6, 'tools/call', {
      name: 'rollback_deployment',
      arguments: {
        org: TARGET.org,
        app: TARGET.app,
        env: TARGET.env,
        deploymentId: previousDeploymentId,
        reason: 'Restore from the deployment detail widget',
      },
    });
    const body = await response.json();

    expect(body.result.structuredContent).toMatchObject({
      ok: true,
      data: {
        target: { app: TARGET.app, env: TARGET.env },
        rollback: {
          deploymentId: previousDeploymentId,
          previousDeploymentId: currentDeploymentId,
          alreadyActive: false,
          ownerSubject: 'oauth-owner-previous',
        },
      },
    });
    expect((await registry.getDeployment(TARGET.org, previousDeploymentId))?.active).toBe(true);
    expect((await registry.getDeployment(TARGET.org, currentDeploymentId))?.active).toBe(false);
    await expect(audit.list({ org: TARGET.org, eventType: 'deploy.rollback' })).resolves.toEqual([
      expect.objectContaining({
        actorSubject: SUBJECT,
        deploymentId: previousDeploymentId,
        decision: 'allow',
      }),
    ]);
  });
});

function widgetMeta(uri: string) {
  return { ui: { resourceUri: uri }, 'openai/outputTemplate': uri };
}
