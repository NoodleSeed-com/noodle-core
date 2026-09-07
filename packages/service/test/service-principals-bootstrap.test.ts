import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { resolveServicePrincipalRuntime } from '../src/oauth/service-bootstrap.js';

describe('service-principal bootstrap isolation', () => {
  it('provides an in-memory runtime for non-Postgres OAuth development', async () => {
    const logger = { error: vi.fn() };
    const runtime = await resolveServicePrincipalRuntime(undefined, logger);

    expect(runtime.ready).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('degrades only service-principal support and emits one bounded redacted event', async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        new Error('SQL failure contains jwk private-key and client-secret material'),
      );
    const logger = { error: vi.fn() };
    const runtime = await resolveServicePrincipalRuntime({ query } as unknown as Pool, logger);

    expect(runtime).toEqual({ ready: false, reason: 'schema_unavailable' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('oauth.service_principals.unavailable', {
      reason: 'schema_unavailable',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
      /SQL|jwk|private-key|client-secret/,
    );
  });
});
