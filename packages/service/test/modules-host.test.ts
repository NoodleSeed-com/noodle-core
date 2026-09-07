import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import {
  type AdmissionContext,
  DEPLOYMENT_ACTIVATION_PHASE,
  MODULE_API_VERSION,
  type PolicyGate,
} from '@noodle-borg/module';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import { noopLogger } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapServiceModules } from '../src/modules/bootstrap.js';
import { ModuleHost } from '../src/modules/host.js';
import { serveService } from '../src/serve.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

function loaded(
  name: string,
  contributions: LoadedServiceModule['contributions'],
  position = 0,
): LoadedServiceModule {
  return {
    module: {
      name,
      version: '0.0.0',
      apiVersion: MODULE_API_VERSION,
      init: () => contributions,
    },
    contributions,
    position,
  };
}

function context(method = 'tools/call'): AdmissionContext {
  return { routeId: 'tenant', method, category: 'execute' };
}

describe('ModuleHost', () => {
  it('orders admission hooks by order and then module position before the host gate', async () => {
    const calls: string[] = [];
    const host = new ModuleHost({
      modules: [
        loaded(
          'late',
          { admission: { id: 'late', order: 20, gate: async () => record(calls, 'late') } },
          0,
        ),
        loaded(
          'early-a',
          { admission: { id: 'early-a', order: 10, gate: async () => record(calls, 'early-a') } },
          1,
        ),
        loaded(
          'early-b',
          { admission: { id: 'early-b', order: 10, gate: async () => record(calls, 'early-b') } },
          2,
        ),
      ],
      admissionGate: async () => record(calls, 'built-in'),
    });

    await expect(host.admissionGate(context())).resolves.toEqual({ allow: true });
    expect(calls).toEqual(['early-a', 'early-b', 'late', 'built-in']);
  });

  it('short-circuits admission on the first deny', async () => {
    const calls: string[] = [];
    const host = new ModuleHost({
      modules: [
        loaded('deny', {
          admission: {
            id: 'deny',
            gate: async () => {
              calls.push('deny');
              return { allow: false, reason: 'blocked', status: 429 };
            },
          },
        }),
      ],
      admissionGate: async () => record(calls, 'built-in'),
    });

    await expect(host.admissionGate(context())).resolves.toEqual({
      allow: false,
      reason: 'blocked',
      status: 429,
    });
    expect(calls).toEqual(['deny']);
  });

  it('uses a single module audit store as primary and mirrors to module sinks', async () => {
    const primary = new InMemoryAuditStore();
    const mirror = new InMemoryAuditStore();
    const hostMirror = new InMemoryAuditStore();
    const host = new ModuleHost({
      modules: [loaded('audit', { auditStore: primary, auditSinks: [mirror] })],
      audit: hostMirror,
    });

    await host.audit.emit({ eventType: 'deploy.accepted', org: 'acme' });

    await expect(primary.list({ org: 'acme' })).resolves.toHaveLength(1);
    await expect(mirror.list({ org: 'acme' })).resolves.toHaveLength(1);
    await expect(hostMirror.list({ org: 'acme' })).resolves.toHaveLength(1);
  });

  it('fails closed for ambiguous singleton contributions', () => {
    const gate: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async (_context, output) => output,
    };
    const sink = new InMemoryAuditStore();

    expect(
      () =>
        new ModuleHost({
          modules: [loaded('a', { auditStore: sink }), loaded('b', { auditStore: sink }, 1)],
        }),
    ).toThrow(/auditStore/i);
    expect(
      () =>
        new ModuleHost({
          modules: [loaded('a', { policyGate: gate }), loaded('b', { policyGate: gate }, 1)],
        }),
    ).toThrow(/policyGate/i);
    expect(
      () =>
        new ModuleHost({
          modules: [
            loaded('a', { authVerifier: async () => null }),
            loaded('b', { authVerifier: async () => null }, 1),
          ],
        }),
    ).toThrow(/authVerifier/i);
    expect(
      () =>
        new ModuleHost({
          modules: [
            loaded('a', { dataPlaneAuthorizer: async () => true }),
            loaded('b', { dataPlaneAuthorizer: async () => true }, 1),
          ],
        }),
    ).toThrow(/dataPlaneAuthorizer/i);
  });

  it('fails closed for duplicate module route ids', () => {
    const route = { id: 'audit.events', match: () => true, handle: () => undefined };
    expect(
      () =>
        new ModuleHost({
          modules: [loaded('a', { routes: [route] }), loaded('b', { routes: [route] }, 1)],
        }),
    ).toThrow(/duplicate module route id/i);
  });

  it('ANDs host and module readiness probes', async () => {
    const ready = new ModuleHost({
      modules: [loaded('ready', { readiness: async () => true })],
      readinessProbe: async () => true,
    });
    const unready = new ModuleHost({
      modules: [loaded('unready', { readiness: async () => false })],
      readinessProbe: async () => true,
    });

    await expect(ready.ready()).resolves.toBe(true);
    await expect(unready.ready()).resolves.toBe(false);
  });

  it('derives product capabilities from module contribution keys only', () => {
    const gate: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async (_context, output) => output,
    };
    const route = { id: 'route.only', match: () => true, handle: () => undefined };
    const host = new ModuleHost({
      modules: [
        loaded('noop', {}),
        loaded('routes', { routes: [route] }, 1),
        loaded('audit', { auditStore: new InMemoryAuditStore() }, 2),
        loaded(
          'policy',
          {
            policyGate: gate,
            admission: { id: 'limits', gate: async () => ({ allow: true }) },
          },
          3,
        ),
      ],
    });

    expect(host.moduleCapabilities).toEqual(['access', 'controls', 'audit']);
  });

  it('allows duplicate derived capabilities when behavior is composable', () => {
    const host = new ModuleHost({
      modules: [
        loaded('readiness-a', { readiness: async () => true }),
        loaded('readiness-b', { readiness: async () => true }, 1),
      ],
    });

    expect(host.moduleCapabilities).toEqual(['observability']);
  });

  it('fails closed for duplicate v2 singleton providers', () => {
    const assetStore = {
      planUploads: async () => ({ assetOrigin: 'https://assets.example', assets: [], uploads: [] }),
      verifyUploadedAssets: async ({ assets }: { assets: readonly [] }) => ({
        ok: true as const,
        assets,
      }),
      recordReachability: async () => undefined,
    };
    const deploymentAutomation = { authorize: async () => ({ kind: 'not-automation' as const }) };
    const platformHumanIdentity = {
      principalResolver: {
        resolve: async () => ({
          subject: 'principal-1',
        }),
        resolveLinked: async () => undefined,
        hasVerifiedEmailEvidence: async () => true,
        assertEmailAvailable: async () => undefined,
        resolveExisting: async () => undefined,
        assertActive: async () => undefined,
        lookupActiveVerifiedEmails: async () => ({ kind: 'known', emails: [] }),
      },
    };

    for (const contributions of [
      { assetStore },
      { deploymentAutomation },
      { platformHumanIdentity },
    ]) {
      expect(
        () =>
          new ModuleHost({
            modules: [loaded('a', contributions), loaded('b', contributions, 1)],
          }),
      ).toThrow(/multiple module/i);
    }
  });

  it('orders tool-dispatch hooks and stops after the first denial', async () => {
    const calls: string[] = [];
    const host = new ModuleHost({
      modules: [
        loaded(
          'late',
          {
            toolDispatch: {
              id: 'late',
              order: 20,
              dispatch: async () => record(calls, 'late'),
            },
          },
          0,
        ),
        loaded(
          'deny',
          {
            toolDispatch: {
              id: 'deny',
              order: 10,
              dispatch: async () => {
                calls.push('deny');
                return { allow: false, reason: 'blocked' };
              },
            },
          },
          1,
        ),
      ],
      toolDispatch: async () => record(calls, 'built-in'),
    });

    await expect(host.toolDispatch?.(toolContext())).resolves.toEqual({
      allow: false,
      reason: 'blocked',
    });
    expect(calls).toEqual(['deny']);
  });

  it('orders activation hooks by fixed contract phase and rejects phase collisions', () => {
    const automation = activation('automation', DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS);
    const commercial = activation('commercial', DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY);
    const host = new ModuleHost({
      modules: [
        loaded('automation', { deploymentActivation: automation }),
        loaded('commercial', { deploymentActivation: commercial }, 1),
      ],
    });

    expect(host.deploymentActivation.map((hook) => hook.id)).toEqual(['commercial', 'automation']);
    expect(
      () =>
        new ModuleHost({
          modules: [
            loaded('a', { deploymentActivation: commercial }),
            loaded('b', { deploymentActivation: activation('other', commercial.phase) }, 1),
          ],
        }),
    ).toThrow(/activation phase.*commercial-authority/i);
  });

  it('requires atomic freshness activation for deployment automation', () => {
    expect(
      () =>
        new ModuleHost({
          modules: [
            loaded('automation', {
              deploymentAutomation: {
                authorize: async () => ({ kind: 'not-automation' as const }),
              },
            }),
          ],
        }),
    ).toThrow(/deployment automation.*automation-freshness/i);
  });

  it('disposes initialized modules when identity continuity fails', async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(
      bootstrapServiceModules({
        inputs: [
          {
            name: 'identity',
            version: '0.0.0',
            apiVersion: MODULE_API_VERSION,
            init: () => ({
              platformHumanIdentity: {
                principalResolver: platformPrincipalResolver(),
                continuityProbe: async () => {
                  throw new Error('identity continuity failed');
                },
              },
              dispose,
            }),
          },
        ],
        allowlist: [],
        importer: undefined,
        logger: noopLogger,
        postgresPool: undefined,
        audit: undefined,
      }),
    ).rejects.toThrow('identity continuity failed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('passes the service clock to initialized modules', async () => {
    const now = new Date('2026-08-23T04:05:06.000Z');
    const observed: Date[] = [];
    const booted = await bootstrapServiceModules({
      inputs: [
        {
          name: 'clock-observer',
          version: '0.0.0',
          apiVersion: MODULE_API_VERSION,
          init: (moduleContext) => {
            observed.push(moduleContext.clock());
            return {};
          },
        },
      ],
      allowlist: [],
      importer: undefined,
      logger: noopLogger,
      postgresPool: undefined,
      audit: undefined,
      clock: () => now,
    });

    expect(observed).toEqual([now]);
    await booted.host.dispose();
  });

  it('disposes initialized modules when host validation fails', async () => {
    const dispose = vi.fn(async () => undefined);
    await expect(
      bootstrapServiceModules({
        inputs: [
          {
            name: 'automation',
            version: '0.0.0',
            apiVersion: MODULE_API_VERSION,
            init: () => ({
              deploymentAutomation: {
                authorize: async () => ({ kind: 'not-automation' as const }),
              },
              dispose,
            }),
          },
        ],
        allowlist: [],
        importer: undefined,
        logger: noopLogger,
        postgresPool: undefined,
        audit: undefined,
      }),
    ).rejects.toThrow(/deployment automation.*automation-freshness/i);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes modules when service startup fails after module boot', async () => {
    const dispose = vi.fn(async () => undefined);
    const controlPlane = new InMemoryControlPlaneStore();
    vi.spyOn(controlPlane, 'allowSignup').mockRejectedValue(new Error('signup store failed'));

    await expect(
      serveService({
        port: 0,
        controlPlaneStore: controlPlane,
        signupAllowedDomains: ['example.test'],
        modules: [
          {
            name: 'worker',
            version: '0.0.0',
            apiVersion: MODULE_API_VERSION,
            init: () => ({ dispose }),
          },
        ],
      }),
    ).rejects.toThrow('signup store failed');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps supplied public defaults when no module provides a v2 capability', async () => {
    const assetStore = {
      planUploads: async () => ({ assetOrigin: 'https://assets.example', assets: [], uploads: [] }),
      verifyUploadedAssets: async ({ assets }: { assets: readonly [] }) => ({
        ok: true as const,
        assets,
      }),
      recordReachability: async () => undefined,
    };
    const host = new ModuleHost({
      assetStore,
      toolDispatch: async () => ({ allow: true }),
    });

    expect(host.assetStore).toBe(assetStore);
    await expect(host.toolDispatch?.(toolContext())).resolves.toEqual({ allow: true });
    expect(host.deploymentActivation).toEqual([]);
  });
});

function activation(id: string, phase: string) {
  return {
    id,
    phase,
    prepare: async () => undefined,
    assert: async () => undefined,
  };
}

function platformPrincipalResolver() {
  return {
    resolve: async () => ({
      subject: 'principal-1',
    }),
    resolveLinked: async () => undefined,
    hasVerifiedEmailEvidence: async () => true,
    assertEmailAvailable: async () => undefined,
    resolveExisting: async () => undefined,
    assertActive: async () => undefined,
    lookupActiveVerifiedEmails: async () => ({ kind: 'known', emails: [] }),
  };
}

function toolContext() {
  return {
    org: 'acme',
    app: 'tasks',
    environment: 'prod',
    deploymentId: 'dep_1',
    toolName: 'create_task',
    toolArguments: {},
    requestId: 1,
    signal: new AbortController().signal,
    client: {},
  };
}

function record(calls: string[], value: string): Promise<{ allow: true }> {
  calls.push(value);
  return Promise.resolve({ allow: true });
}
