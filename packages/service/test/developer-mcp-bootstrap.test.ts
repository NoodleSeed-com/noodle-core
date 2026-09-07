import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { noopLogger } from '@noodle-borg/transport-http';
import { describe, expect, it } from 'vitest';
import { createDeveloperMcpMountOptions } from '../src/developer-mcp/service-options.js';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { DeveloperGrantAuthorizer } from '../src/oauth/developer-grant-authorizer.js';
import {
  createDeveloperGrantAuthorizer,
  resolveDeveloperGrantStore,
} from '../src/oauth/developer-grant-bootstrap.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

describe('Developer MCP service bootstrap', () => {
  it('preserves an injected developer grant store without PostgreSQL', async () => {
    const store = new InMemoryDeveloperGrantStore();

    await expect(resolveDeveloperGrantStore({ store })).resolves.toBe(store);
  });

  it('creates the OAuth authorizer over the developer grant store', () => {
    const grants = new InMemoryDeveloperGrantStore();

    expect(createDeveloperGrantAuthorizer({ grants })).toBeInstanceOf(DeveloperGrantAuthorizer);
  });

  it('maps service-owned dependencies into the request-scoped MCP mount', () => {
    const grants = new InMemoryDeveloperGrantStore();
    const controlPlane = new InMemoryControlPlaneStore();
    const audit = new InMemoryAuditStore();
    const registry = {} as Parameters<typeof createDeveloperMcpMountOptions>[0]['registry'];
    const logs = {} as NonNullable<
      Parameters<typeof createDeveloperMcpMountOptions>[0]['options']['userAppLogStore']
    >;
    const requestEvents = {} as NonNullable<
      Parameters<typeof createDeveloperMcpMountOptions>[0]['options']['requestEventStore']
    >;
    const verifyOwnerToken = async () => null;

    const mounted = createDeveloperMcpMountOptions({
      registry,
      controlPlane,
      audit,
      logger: noopLogger,
      tls: {},
      maxBody: 123,
      options: {
        developerGrantStore: grants,
        userAppLogStore: logs,
        requestEventStore: requestEvents,
        verifyOwnerToken,
        publicBaseUrl: 'https://borg.example.test',
        mcpPublicRouting: { publicBaseDomain: 'mcp.example.test' },
      },
    });

    expect(mounted).toMatchObject({
      registry,
      controlPlane,
      audit,
      grants,
      logs,
      requestEvents,
      verifyOwnerToken,
      maxBody: 123,
      publicBaseUrl: 'https://borg.example.test',
      publicBaseDomain: 'mcp.example.test',
    });
  });
});
