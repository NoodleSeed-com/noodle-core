import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

function catalog(header = 'X-Adapter-Key', extra = '') {
  return `connectors:
  - id: application_api
    version: 1.0.0
    credentialProfiles: { account: { kind: bearer } }
    http:
      baseUrl: https://application.example
      transportAuth: { kind: apiKey, header: ${header}, secret: ADAPTER_KEY }
      ${extra}
    operations:
      read:
        type: read
        method: GET
        path: /read
        credentials: { profiles: [account] }
        input: { type: object, properties: {}, additionalProperties: false }
        output: { type: object, properties: {}, additionalProperties: false }
`;
}

describe('independent HTTP transport authentication', () => {
  it('retains the transport secret only in broker bindings, independent of the account profile', () => {
    const compiled = compileConnectors(catalog());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.secretBindings).toEqual([
      { connectorId: 'application_api', connectorVersion: '1.0.0', secretRef: 'ADAPTER_KEY' },
    ]);
    expect(JSON.stringify(compiled.catalog)).not.toContain('ADAPTER_KEY');
  });

  it.each([
    'Authorization',
    'Cookie',
    'Host',
    'Content-Type',
    'Connection',
    'Proxy-Authorization',
    'Transfer-Encoding',
    'Set-Cookie',
    'X-Forwarded-For',
    'X-Real-IP',
    'X-HTTP-Method-Override',
  ])('rejects reserved transport credential header %s', (header) => {
    expect(compileConnectors(catalog(header)).ok).toBe(false);
  });

  it('does not reinterpret or combine legacy auth', () => {
    expect(
      compileConnectors(catalog('X-Adapter-Key', 'auth: { kind: bearer, secret: OLD_KEY }')).ok,
    ).toBe(false);
  });
});
