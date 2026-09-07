import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { resolveRecoveryMode } from '../src/recovery-quarantine.js';
import { ServerRegistry } from '../src/registry.js';
import { serveService } from '../src/serve.js';
import { createServiceHandler } from '../src/service.js';
import { closeHttpServer, listenHttpServer } from '../src/service-resource-cleanup.js';

const installation = '/v1/orgs/acme/solution-installations/sales';
const blocked = [
  ['GET', installation],
  ['GET', `${installation}/collections/leads/records`],
  ['GET', `${installation}/collections/leads/records/retained`],
  ['GET', `${installation}/collections/leads/records/retained/activity`],
  ['GET', `${installation}/collections/leads/records/export`],
  ['GET', `${installation}/settings`],
  ['GET', `${installation}/grants`],
  ['GET', `${installation}/activity`],
  ['POST', `${installation}/collections/products/source/refresh`],
  ['POST', `${installation}/connections/google/connect`],
  ['POST', '/v1/solution-connections/callback'],
  ['POST', '/v1/solution-intake/retained/leads/records'],
  ['POST', '/o/acme/sales/mcp'],
  ['POST', '/o/acme/sales/prod/mcp'],
  ['POST', '/developer/mcp'],
  ['POST', '/v1/assistant/sessions'],
  ['POST', '/v1/assistant/public-sessions'],
  ['POST', '/v1/assistant/interactions'],
  ['POST', '/v1/assistant/tool-confirmations'],
  ['POST', '/v1/assistant/turns'],
  ['POST', '/v1/assistant/transcript'],
  ['POST', '/token'],
  ['GET', '/authorize'],
  ['POST', '/v1/orgs/acme/apps/sales/envs/prod/deploy'],
  ['GET', '/v1/orgs/acme/apps/sales/envs/prod/variables'],
  ['GET', '/v1/whoami'],
  ['GET', '/assets/retained.js'],
  ['OPTIONS', '/o/acme/sales/mcp'],
] as const;

describe('whole-candidate deployment recovery quarantine', () => {
  it('accepts only explicit deployment modes; absence preserves ordinary boot', () => {
    expect(resolveRecoveryMode(undefined)).toBeUndefined();
    expect(resolveRecoveryMode('quarantined')).toBe('quarantined');
    expect(resolveRecoveryMode('reopened')).toBe('reopened');
    for (const value of ['', 'false', 'normal', 'QUARANTINED', ' reopened'])
      expect(() => resolveRecoveryMode(value)).toThrow(/recovery mode/i);
  });

  it('denies all data surfaces before registry, module, auth or archive work, including stale owner claims', async () => {
    const registry = new ServerRegistry();
    const lookup = vi.spyOn(registry, 'getServing');
    const sweep = vi.spyOn(registry, 'sweepArchived');
    const inspect = vi.fn();
    const server = createServer(
      createServiceHandler(registry, {
        recoveryMode: 'quarantined',
        readinessProbe: inspect,
        consoleHandler: inspect,
        authServerApp: inspect,
        developerMcp: true,
      }),
    );
    await listenHttpServer(server, 0, '127.0.0.1');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const [method, path] of blocked) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { authorization: 'Bearer restored-admin-token' },
        });
        expect(response.status, `${method} ${path}`).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
          error: 'This service is quarantined for recovery.',
          code: 'recovery_quarantined',
        });
      }
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/v1/service/info`)).status).toBe(200);
      expect(inspect).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      await closeHttpServer(server);
    }
  });

  it('boots probe-only before configuration, database, retention or provider setup and survives restart', async () => {
    const store = new InMemoryBusinessInformationStore();
    const purge = vi.spyOn(store, 'purgeExpired');
    const scan = vi.fn();
    const moduleImporter = vi.fn();
    for (let restart = 0; restart < 2; restart += 1) {
      const service = await serveService({
        port: 0,
        recoveryMode: 'quarantined',
        databaseUrl: 'postgres://unreachable.invalid/restored',
        // Missing cipher/provider configuration must not start or unblock ordinary boot.
        businessInformationStore: store,
        businessInformationSourceExecutor: { scan },
        modules: [{ package: 'untrusted-module-must-not-load' }],
        moduleImporter,
      });
      try {
        expect((await fetch(`${service.url}/readyz`)).status).toBe(503);
        expect((await fetch(`${service.url}${installation}`)).status).toBe(503);
      } finally {
        await service.close();
      }
    }
    expect(purge).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(moduleImporter).not.toHaveBeenCalled();
  });

  it('requires explicit operation custody epoch before reopened ordinary boot', async () => {
    await expect(serveService({ port: 0, recoveryMode: 'reopened' })).rejects.toThrow(
      /recovery.*epoch/i,
    );
  });
});
