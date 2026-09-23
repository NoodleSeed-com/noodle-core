import {
  MODULE_API_VERSION,
  type ModuleHostContext,
  type ServiceModule,
} from '@noodle-borg/module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '../src/index.js';
import { parseServiceRunMode } from '../src/main.js';

/** Everything a boot can start: timers, the WhatsApp worker, the welcome email sender and module init. */
function instrumentedBoot(runMode: 'serve-only' | undefined) {
  const contexts: ModuleHostContext[] = [];
  const probe: ServiceModule = {
    name: '@noodle-borg/run-mode-probe',
    version: '0.0.0',
    apiVersion: MODULE_API_VERSION,
    init: (context) => {
      contexts.push(context);
      return {};
    },
  };
  const worker = new ChannelWorkerLoop();
  const workerStart = vi.spyOn(worker, 'start');
  const send = vi.fn(async () => ({ providerMessageId: 'never' }));
  const controlPlaneStore = new InMemoryControlPlaneStore();
  const allowSignup = vi.spyOn(controlPlaneStore, 'allowSignup');
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const boot = serveService({
    port: 0,
    modules: [probe],
    whatsapp: { store: {} as never, worker },
    welcomeEmailSender: { send },
    controlPlaneStore,
    signupAllowedDomains: ['example.com'],
    ...(runMode === undefined ? {} : { runMode }),
  });
  return { boot, contexts, workerStart, send, intervals, allowSignup };
}

describe('service run mode', () => {
  let service: RunningService | undefined;
  afterEach(async () => {
    await service?.close();
    service = undefined;
    vi.restoreAllMocks();
  });

  it('parses NOODLE_RUN_MODE: absent is full, serve-only is exact, anything else fails closed', () => {
    expect(parseServiceRunMode(undefined)).toBe('full');
    expect(parseServiceRunMode('')).toBe('full');
    expect(parseServiceRunMode('serve-only')).toBe('serve-only');
    for (const value of ['full', 'serve_only', 'SERVE-ONLY', 'readonly'])
      expect(() => parseServiceRunMode(value)).toThrow(
        'NOODLE_RUN_MODE must be absent or exactly serve-only',
      );
  });

  it('serve-only starts no timer, worker, sender or allowlist write, and tells every module', async () => {
    const booted = instrumentedBoot('serve-only');
    service = await booted.boot;
    expect(booted.intervals).not.toHaveBeenCalled();
    expect(booted.workerStart).not.toHaveBeenCalled();
    expect(booted.send).not.toHaveBeenCalled();
    expect(booted.allowSignup).not.toHaveBeenCalled();
    expect(booted.contexts.map((context) => context.runMode)).toEqual(['serve-only']);
    expect(service.registry).toBeDefined();
  });

  it('the default mode still starts its background work', async () => {
    const booted = instrumentedBoot(undefined);
    service = await booted.boot;
    expect(booted.intervals).toHaveBeenCalled();
    expect(booted.workerStart).toHaveBeenCalledOnce();
    expect(booted.allowSignup).toHaveBeenCalledOnce();
    expect(booted.contexts.map((context) => context.runMode)).toEqual(['full']);
  });

  it('serve-only answers the read-only probes and refuses every other request', async () => {
    service = await instrumentedBoot('serve-only').boot;
    for (const path of ['/healthz', '/readyz', '/v1/service/info', '/v1/service/capabilities'])
      expect((await fetch(`${service.url}${path}`)).status, path).toBe(200);
    for (const [method, path] of [
      ['GET', '/v1/orgs/smoke-probe/deployments'],
      ['POST', '/v1/orgs/local/apps'],
      ['POST', '/mcp/local/app/prod'],
      ['POST', '/v1/service/info'],
      ['HEAD', '/healthz'],
      ['GET', '/oauth/authorize'],
    ] as const) {
      const response = await fetch(`${service.url}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      if (method !== 'HEAD')
        expect(await response.json(), `${method} ${path}`).toMatchObject({ code: 'serve_only' });
    }
  });
});
