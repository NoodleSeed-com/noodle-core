import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  Connector,
  ConnectorCall,
  CredentialRequest,
  ExecuteDeps,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { mapExecutionError, type ServedArtifact } from '../src/index.js';
import { connectClientTo } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'compiler', 'fixtures', 'valid');
const SENTINEL = 'https://sentinel.api.noodleseed.dev/private';
const SIGNATURE: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: {}, additionalProperties: false },
};

function served(): {
  readonly value: ServedArtifact;
  readonly connectorCalls: ConnectorCall[];
  readonly credentialRequests: CredentialRequest[];
} {
  const base = JSON.parse(
    readFileSync(join(fixtures, 'customer-routing.artifact.json'), 'utf8'),
  ) as RuntimeArtifact;
  const artifact: RuntimeArtifact = {
    ...base,
    tools: base.tools.map((tool) => ({
      ...tool,
      authorization: { requiredScopes: ['records.read'] },
    })),
  };
  const connectorCalls: ConnectorCall[] = [];
  const credentialRequests: CredentialRequest[] = [];
  const connector: Connector = {
    id: 'customer_records',
    version: '1.0.0',
    signature: () => SIGNATURE,
    invoke(call) {
      connectorCalls.push(call);
      return {};
    },
  };
  const deps: ExecuteDeps = {
    connectors: { resolve: () => connector },
    broker: {
      async getCredential(request) {
        credentialRequests.push(request);
        return { token: 'downstream' };
      },
    },
  };
  return {
    value: { artifact, deps },
    connectorCalls,
    credentialRequests,
  };
}

describe('protocol customer routing', () => {
  it('maps unavailable routes to one generic error without retaining internal messages', () => {
    expect(
      mapExecutionError({
        code: 'connector_route_unavailable',
        message: 'tenant route https://customer-api.invalid must not survive mapping',
      }),
    ).toEqual({
      result: {
        content: [
          {
            type: 'text',
            text: 'Customer connector route is unavailable.',
          },
        ],
        structuredContent: {
          error: { code: 'connector_route_unavailable' },
        },
        isError: true,
      },
    });
  });

  it('keeps an authorized routed tool discoverable when its route is unavailable', async () => {
    const setup = served();
    const client = await connectClientTo(setup.value, {
      caller: { subject: 'customer-123', scopes: ['records.read'], roles: [] },
      customerRouting: {},
    });

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'list_records' })],
    });
    const result = await client.callTool({ name: 'list_records', arguments: {} });
    expect(result).toEqual(
      expect.objectContaining({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Customer connector route is unavailable.',
          },
        ],
        structuredContent: {
          error: { code: 'connector_route_unavailable' },
        },
      }),
    );
    const publicPayload = JSON.stringify(result);
    for (const forbidden of [
      'customer_api',
      'tenant.api_base_url',
      'allowedHttpsHostSuffixes',
      'fingerprint',
      SENTINEL,
    ]) {
      expect(publicPayload).not.toContain(forbidden);
    }
    expect(setup.credentialRequests).toEqual([]);
    expect(setup.connectorCalls).toEqual([]);
  });

  it('freezes a valid raw route once while retaining caller-only discovery behavior', async () => {
    const setup = served();
    let reads = 0;
    const raw = Object.create(null) as Record<string, string>;
    Object.defineProperty(raw, 'customer_api', {
      enumerable: true,
      get() {
        reads += 1;
        return SENTINEL;
      },
    });
    const client = await connectClientTo(setup.value, {
      caller: { subject: 'customer-123', scopes: ['records.read'], roles: [] },
      customerIssuer: 'https://customer-idp.example',
      customerRouting: raw,
    });

    await client.listTools();
    await client.callTool({ name: 'list_records', arguments: {} });
    await client.callTool({ name: 'list_records', arguments: {} });

    expect(reads).toBe(1);
    expect(setup.connectorCalls.map((call) => call.route?.baseUrl)).toEqual([SENTINEL, SENTINEL]);
    expect(setup.credentialRequests.map((request) => request.customerIssuer)).toEqual([
      'https://customer-idp.example',
      'https://customer-idp.example',
    ]);
    expect(
      setup.connectorCalls.every((call) => !Object.hasOwn(call.caller ?? {}, 'customerIssuer')),
    ).toBe(true);
    expect(JSON.stringify(setup.credentialRequests)).not.toContain(SENTINEL);
  });

  it('normalizes hostile connector rejection proxies without exposing route data', async () => {
    const setup = served();
    const connector = setup.value.deps.connectors.resolve(
      setup.value.artifact.tools[0]?.fulfilment.kind === 'operation'
        ? setup.value.artifact.tools[0].fulfilment.operationRef
        : ({ resolved: false } as never),
    );
    if (connector === undefined) throw new Error('expected connector');
    connector.invoke = () =>
      Promise.reject(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error(`protocol proxy trap ${SENTINEL}`);
            },
          },
        ),
      );
    const client = await connectClientTo(setup.value, {
      caller: { subject: 'customer-123', scopes: ['records.read'], roles: [] },
      customerRouting: { customer_api: SENTINEL },
    });

    const result = await client.callTool({ name: 'list_records', arguments: {} });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
