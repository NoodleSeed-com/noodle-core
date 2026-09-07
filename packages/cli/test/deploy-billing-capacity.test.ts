import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploy } from '../src/deploy.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');

describe('deploy billing-capacity failures', () => {
  it.each([
    ['production_app_limit_exceeded', 409],
    ['billing_enforcement_unavailable', 503],
  ] as const)('preserves the service %s code', async (code, status) => {
    const outcome = await deploy({
      manifestPath: HELLO,
      serviceUrl: 'https://service.example',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, code, error: code }), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    expect(outcome).toMatchObject({ ok: false, status, code, message: code });
  });
});
