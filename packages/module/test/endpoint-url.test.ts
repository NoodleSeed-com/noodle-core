import { describe, expect, it } from 'vitest';
import { tenantMcpUrl } from '../src/index.js';

const tenant = { org: 'acme-internal', app: 'todoist', env: 'prod' };

describe('tenantMcpUrl', () => {
  it('formats public URLs only from an explicit MCP subdomain', () => {
    expect(
      tenantMcpUrl('https://service.example', tenant, '2.0', {
        publicBaseDomain: 'cloud.noodleseed.dev',
        mcpSubdomain: 'arez',
      }),
    ).toBe('https://arez.cloud.noodleseed.dev/todoist/v2_0/mcp');
  });

  it('fails closed instead of deriving a public host from the org slug', () => {
    expect(() =>
      tenantMcpUrl('https://service.example', tenant, undefined, {
        publicBaseDomain: 'cloud.noodleseed.dev',
      }),
    ).toThrow('MCP subdomain is required');
  });

  it('keeps legacy service paths keyed by the immutable org slug', () => {
    expect(tenantMcpUrl('https://service.example', tenant)).toBe(
      'https://service.example/o/acme-internal/todoist/mcp',
    );
  });

  it('normalizes a trailing-slash base to exactly one endpoint path separator', () => {
    expect(tenantMcpUrl('https://service.example/', tenant)).toBe(
      'https://service.example/o/acme-internal/todoist/mcp',
    );
  });
});
