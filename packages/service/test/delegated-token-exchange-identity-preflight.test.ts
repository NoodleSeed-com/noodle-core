import { describe, expect, it } from 'vitest';
import { InMemoryConfigStore, ServerRegistry } from '../src/index.js';

const manifest = `
manifestVersion: "1"
server:
  name: broken_exchange
  version: 1.0.0
  title: Broken Exchange
tools:
  - name: ping
    description: Return readiness.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment:
      steps:
        - id: ready
          map: { ok: true }
      output: { ok: "\${steps.ready.ok}" }
`;

const connectors = `
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

describe('hosted delegated token exchange identity preflight', () => {
  it('rejects the deployment before registering an unusable server', async () => {
    const config = new InMemoryConfigStore();
    await config.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'broken-exchange', env: 'prod' },
      name: 'UNRELATED_SECRET',
      value: 'must-never-appear',
    });
    const registry = new ServerRegistry(undefined, undefined, config);

    const result = await registry.deploy(
      { org: 'acme', app: 'broken-exchange', env: 'prod' },
      manifest,
      { connectors },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: 'delegated_token_exchange_identity_required',
        path: 'server.auth',
        message:
          'delegatedTokenExchange on acmehr_api.* requires a verified customer identity source; declare server.auth with customerAuth(...) or server.assistant with embeddedAssistant(...)',
      },
      {
        code: 'missing_secret',
        path: 'secrets.ACMEHR_DELEG_CLIENT_SECRET',
        message: 'no managed value found for required secret "ACMEHR_DELEG_CLIENT_SECRET"',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must-never-appear');
    expect(result).not.toHaveProperty('compiledArtifact');
    expect(registry.size).toBe(0);
  });
});
