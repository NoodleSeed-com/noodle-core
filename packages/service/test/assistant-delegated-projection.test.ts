import {
  delegatedAuthOperationKeys,
  toolTouchesDelegatedAuth,
} from '@noodle-borg/assistant-gateway';
import { describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/index.js';

/**
 * Fail-closed half of the connector-auth-kind classification (ADR 0201, amended 2026-08-19).
 *
 * A tool backed by caller-derived (delegated) connector auth needs a signed-in caller to execute.
 * On a `public` surface no sign-in can ever exist, so projecting one there is an inevitable runtime
 * `credential_unavailable` — this preflight moves it to the deploy boundary, exactly like the
 * delegated-exchange identity check it sits beside.
 */

const DELEGATED_CONNECTORS = `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`;

const STATIC_CONNECTORS = `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: bearer
        secret: ACMEHR_STATIC_TOKEN
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`;

function manifest(surfaces: string): string {
  return `
manifestVersion: "1"
server:
  name: timeoff
  version: 1.0.0
  title: Time Off
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
${surfaces}
    allowedOrigins: [https://www.acme.test, https://app.acme.test]
connectors:
  acmehr:
    id: acmehr_api
    version: 1.0.0
tools:
  - name: team_time_off
    description: Read the team's time-off calendar.
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment:
      use: acmehr.list_time_off
      args: {}
`;
}

const PUBLIC_PROJECTING = `      - mode: public
        origins: [https://www.acme.test]
        capabilities:
          - { kind: tool, name: team_time_off }
      - mode: authenticated
        origins: [https://app.acme.test]`;

const PUBLIC_NOT_PROJECTING = `      - mode: public
        origins: [https://www.acme.test]
        capabilities: []
      - mode: authenticated
        origins: [https://app.acme.test]`;

const MIXED_PROJECTING = `      - mode: mixed
        origins: [https://www.acme.test]
        capabilities:
          - { kind: tool, name: team_time_off }`;

async function deploy(surfaces: string, connectors: string) {
  const registry = new ServerRegistry();
  const tenant = { org: 'acme', app: 'timeoff', env: 'prod' };
  const scope = { level: 'env' as const, ...tenant };
  for (const [name, value] of [
    ['ASSISTANT_MODEL_BASE_URL', 'https://model.test'],
    ['ASSISTANT_MODEL', 'acme-model'],
  ]) {
    await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
  }
  for (const name of [
    'ASSISTANT_MODEL_API_KEY',
    'ACMEHR_DELEG_CLIENT_SECRET',
    'ACMEHR_STATIC_TOKEN',
  ]) {
    await registry.configStore.setConfigValue({ kind: 'secret', scope, name, value: 'set' });
  }
  return registry.deploy(tenant, manifest(surfaces), { connectors, accessMode: 'public' });
}

describe('public-surface delegated-auth preflight', () => {
  it('rejects a delegated-auth tool projected to a public surface', async () => {
    const result = await deploy(PUBLIC_PROJECTING, DELEGATED_CONNECTORS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: 'assistant_public_delegated_auth',
        path: 'server.assistant.surfaces[0].capabilities',
        message:
          'tool "team_time_off" reaches a connector operation that authenticates as the signed-in user; a public surface has no sign-in, so the call can never execute. Project it to a mixed surface (publicWebsite({ signIn: true })) or an authenticated one',
      },
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('ACMEHR_DELEG_CLIENT_SECRET');
  });

  it('accepts the same tool on a mixed surface, where it is the sign-in trigger', async () => {
    const result = await deploy(MIXED_PROJECTING, DELEGATED_CONNECTORS);
    expect(result.ok, JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  });

  it('accepts a public surface that does not project the delegated tool', async () => {
    const result = await deploy(PUBLIC_NOT_PROJECTING, DELEGATED_CONNECTORS);
    expect(result.ok, JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  });

  it('accepts service-credential (non-delegated) tools on a public surface', async () => {
    // ADR 0055: anonymity is about the caller, not the tenant's downstream auth — a managed static
    // credential resolves for anonymous callers exactly as for identified ones.
    const result = await deploy(PUBLIC_PROJECTING, STATIC_CONNECTORS);
    expect(result.ok, JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  });
});

describe('delegated-auth classification joins', () => {
  it('keys delegated bindings by operation with a connector-default wildcard', () => {
    const keys = delegatedAuthOperationKeys([
      {
        connectorId: 'a',
        connectorVersion: '1',
        operation: 'op',
        authKind: 'delegatedTokenExchange',
      },
      { connectorId: 'b', connectorVersion: '1', authKind: 'delegatedOAuth' },
      {
        connectorId: 'c',
        connectorVersion: '1',
        operation: 'op',
        authKind: 'delegatedSessionCookie',
      },
      { connectorId: 'd', connectorVersion: '1', operation: 'op', authKind: 'static' },
      { connectorId: 'e', connectorVersion: '1', operation: 'op', authKind: 'clientCredentials' },
      { connectorId: 'f', connectorVersion: '1', operation: 'op' },
    ]);
    expect([...keys].sort()).toEqual(['a|op', 'b|*', 'c|op']);
  });

  it('matches single-operation and flow-step fulfilments, including the wildcard', () => {
    const keys = new Set(['acmehr_api|list_time_off', 'crm|*']);
    const ref = (connectorId: string, operation: string) =>
      ({
        resolved: true,
        alias: 'x',
        connectorId,
        connectorVersion: '1',
        operation,
        signatureHash: 'sha256:0',
      }) as const;

    expect(
      toolTouchesDelegatedAuth(
        {
          fulfilment: {
            kind: 'operation',
            operationRef: ref('acmehr_api', 'list_time_off'),
            args: {},
          },
        } as never,
        keys,
      ),
    ).toBe(true);
    expect(
      toolTouchesDelegatedAuth(
        {
          fulfilment: {
            kind: 'flow',
            steps: [
              { id: 's1', kind: 'map', value: {} },
              { id: 's2', kind: 'operation', operationRef: ref('crm', 'any_operation'), args: {} },
            ],
            output: {},
          },
        } as never,
        keys,
      ),
    ).toBe(true);
    expect(
      toolTouchesDelegatedAuth(
        {
          fulfilment: { kind: 'operation', operationRef: ref('acmehr_api', 'other_op'), args: {} },
        } as never,
        keys,
      ),
    ).toBe(false);
    // Unresolved refs (shape-only artifacts) never match: the deploy target always resolves.
    expect(
      toolTouchesDelegatedAuth(
        {
          fulfilment: {
            kind: 'operation',
            operationRef: { resolved: false, connector: 'acmehr_api', operation: 'list_time_off' },
            args: {},
          },
        } as never,
        keys,
      ),
    ).toBe(false);
  });
});
