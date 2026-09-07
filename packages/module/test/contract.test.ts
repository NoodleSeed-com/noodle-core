import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  AssetPlanError,
  adaptModuleLogger,
  compareServerVersions,
  DEPLOYMENT_ACTIVATION_PHASE,
  DeploymentActivationError,
  formatPublicMcpUrl,
  LEGACY_MODULE_API_VERSION,
  MODULE_API_VERSION,
  type ModuleContributions,
  type ModuleHostContext,
  type ModuleRouteContext,
  normalizeServerVersion,
  OPENAI_APPS_CHALLENGE_PATH,
  PlatformIdentityError,
  parseCanonicalLegacyTenantMcpUrl,
  parseCanonicalPublicMcpUrl,
  parseLegacyTenantMcpPath,
  parsePublicMcpUrl,
  parsePublicOrgWellKnownUrl,
  type ServiceModule,
  type ServiceModuleV1,
  serverVersionFromPathSegment,
  serverVersionPathSegment,
} from '../src/index.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function context(): ModuleHostContext {
  return {
    logger,
    clock: () => new Date('2026-06-13T00:00:00.000Z'),
    options: { enabled: true },
  };
}

describe('ServiceModule contract', () => {
  it('accepts a module that contributes every capability', async () => {
    const auditStore = {
      emit: async () => undefined,
      list: async () => [],
    };
    const policyGate = {
      before: async () => ({ allow: true as const }),
      after: async (_context: unknown, output: unknown) => output,
    };
    const module: ServiceModule = {
      name: '@noodle-borg/test-module',
      version: '0.0.0',
      apiVersion: MODULE_API_VERSION,
      init: async (): Promise<ModuleContributions> => ({
        routes: [
          {
            id: 'test.route',
            match: (method, url) => method === 'GET' && url.pathname === '/test',
            handle: () => undefined,
          },
        ],
        admission: {
          id: 'test.admission',
          order: 10,
          gate: async () => ({ allow: true }),
        },
        auditSinks: [auditStore],
        auditStore,
        policyGate,
        authVerifier: async () => ({ subject: 'user-1' }),
        dataPlaneAuthorizer: async () => true,
        assetStore: {
          planUploads: async () => ({
            assetOrigin: 'https://assets.example',
            assets: [],
            uploads: [],
          }),
          verifyUploadedAssets: async ({ assets }) => ({ ok: true, assets }),
          recordReachability: async () => undefined,
        },
        deploymentAutomation: {
          authorize: async () => ({
            kind: 'denied',
            status: 400,
            code: 'invalid_automation_deploy',
            message: 'invalid automation deploy',
          }),
        },
        platformHumanIdentity: {
          principalResolver: {
            resolve: async (identity) => ({
              subject: identity.subject,
              billingIdentity: { identityIssuer: identity.realm, subject: identity.subject },
            }),
            resolveLinked: async () => undefined,
            hasVerifiedEmailEvidence: async () => true,
            assertEmailAvailable: async () => undefined,
            resolveExisting: async () => undefined,
            assertActive: async () => undefined,
          },
        },
        toolDispatch: {
          id: 'test.tool-dispatch',
          order: 10,
          dispatch: async () => ({ allow: true }),
        },
        deploymentActivation: {
          id: 'test.activation',
          phase: DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
          prepare: async () => ({ prepared: true }),
          assert: async () => undefined,
        },
        readiness: async () => true,
        dispose: async () => undefined,
      }),
    };

    const contributions = await module.init(context());

    expect(module.apiVersion).toBe(MODULE_API_VERSION);
    expect(contributions.routes?.[0]?.id).toBe('test.route');
    expect(contributions.admission?.id).toBe('test.admission');
    expect(contributions.auditStore).toBe(auditStore);
    expect(contributions.policyGate).toBe(policyGate);
    expect(contributions.assetStore).toBeDefined();
    expect(contributions.deploymentAutomation).toBeDefined();
    expect(contributions.platformHumanIdentity).toBeDefined();
    expect(contributions.toolDispatch?.id).toBe('test.tool-dispatch');
    expect(contributions.deploymentActivation?.phase).toBe(
      DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
    );
    await expect(Promise.resolve(contributions.readiness?.())).resolves.toBe(true);
  });

  it('keeps the legacy module contract explicit and limited to v1 contributions', async () => {
    const module: ServiceModuleV1 = {
      name: '@noodle-borg/legacy-module',
      version: '1.0.0',
      apiVersion: LEGACY_MODULE_API_VERSION,
      init: () => ({ readiness: () => true }),
    };

    const contributions = await module.init(context());

    expect(module.apiVersion).toBe(1);
    await expect(Promise.resolve(contributions.readiness?.())).resolves.toBe(true);
  });

  it('marks asset planning failures without depending on an adapter implementation', () => {
    const error = new AssetPlanError('quota exceeded');

    expect(error).toMatchObject({ name: 'AssetPlanError', assetPlanError: true });
    expect(error.message).toBe('quota exceeded');
  });

  it('shares platform identity failures across provider and consumer packages', () => {
    const error = new PlatformIdentityError('principal_suspended');

    expect(error).toMatchObject({ name: 'PlatformIdentityError', code: 'principal_suspended' });
  });

  it('shares typed automation activation rejection without naming a provider', () => {
    const error = new DeploymentActivationError('automation_superseded');

    expect(error).toMatchObject({
      name: 'DeploymentActivationError',
      code: 'automation_superseded',
    });
  });

  it('accepts a no-op module as inert', async () => {
    const module: ServiceModule = {
      name: '@noodle-borg/noop-module',
      version: '0.0.0',
      apiVersion: MODULE_API_VERSION,
      init: () => ({}),
    };

    expect(await Promise.resolve(module.init(context()))).toEqual({});
  });
});

describe('module logger adapter', () => {
  it('preserves levels and composes child fields for service integrations', () => {
    const entries: Array<{
      level: string;
      event: string;
      fields: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const adapted = adaptModuleLogger(
      {
        debug: (event, fields) => entries.push({ level: 'debug', event, fields }),
        info: (event, fields) => entries.push({ level: 'info', event, fields }),
        warn: (event, fields) => entries.push({ level: 'warn', event, fields }),
        error: (event, fields) => entries.push({ level: 'error', event, fields }),
      },
      { module: 'billing', shared: 'base' },
    );

    adapted.child({ accountId: 'acct_1', shared: 'child' }).warn('grant.expiring', {
      grantId: 'grant_1',
    });
    adapted.log('error', 'grant.failed', { errorCode: 'storage_unavailable' });

    expect(entries).toEqual([
      {
        level: 'warn',
        event: 'grant.expiring',
        fields: {
          module: 'billing',
          shared: 'child',
          accountId: 'acct_1',
          grantId: 'grant_1',
        },
      },
      {
        level: 'error',
        event: 'grant.failed',
        fields: {
          module: 'billing',
          shared: 'base',
          errorCode: 'storage_unavailable',
        },
      },
    ]);
  });
});

describe('commercial route host capabilities', () => {
  it('provides tenant authorization and a deployment package view without exposing the service registry', async () => {
    const routeContext: ModuleRouteContext = {
      logger,
      tenantControl: {
        authorize: async (_request, input) => ({
          ok: true,
          identity: {
            subject: `publisher:${input.org}`,
            email: 'publisher@acme.test',
            superAdmin: false,
          },
        }),
      },
      deploymentPackages: {
        get: async (_request, input) => ({
          deploymentId: input.deploymentId,
          appSlug: 'tasks',
          environment: 'prod',
          active: true,
          accessMode: 'org-members',
          endpointUrl: 'https://acme.cloud.noodleseed.dev/tasks/v1/mcp',
          snapshotSha256: 'a'.repeat(64),
          appPackage: {
            name: 'acme_tasks',
            version: '1.0.0',
            sourceManifestSha256: 'b'.repeat(64),
            mcpSurfaceSha256: 'c'.repeat(64),
            skillMarkdown: '# Acme Tasks\n',
            referenceMarkdown: '# MCP surface\n',
          },
        }),
      },
      distributionDelivery: {
        get: async (_request, input) => ({
          deploymentId: input.deploymentId,
          appSlug: 'tasks',
          environment: 'prod',
          active: true,
          accessMode: 'public',
          snapshotSha256: 'a'.repeat(64),
        }),
      },
    };
    const request = {} as IncomingMessage;

    await expect(
      routeContext.tenantControl?.authorize(request, {
        org: 'acme',
        permission: 'deployments:write',
      }),
    ).resolves.toMatchObject({ ok: true, identity: { subject: 'publisher:acme' } });
    await expect(
      routeContext.deploymentPackages?.get(request, { org: 'acme', deploymentId: 'dep_1' }),
    ).resolves.toMatchObject({ deploymentId: 'dep_1', snapshotSha256: 'a'.repeat(64) });
    await expect(
      routeContext.distributionDelivery?.get(request, {
        org: 'acme',
        deploymentId: 'dep_1',
      }),
    ).resolves.toEqual({
      deploymentId: 'dep_1',
      appSlug: 'tasks',
      environment: 'prod',
      active: true,
      accessMode: 'public',
      snapshotSha256: 'a'.repeat(64),
    });
  });
});

describe('server version helpers', () => {
  it('normalizes CLI and URL friendly versions', () => {
    expect(normalizeServerVersion('1')).toBe('1');
    expect(normalizeServerVersion('v1')).toBe('1');
    expect(normalizeServerVersion('2.0.6')).toBe('2.0.6');
    expect(normalizeServerVersion('v2_0_6')).toBe('2.0.6');
    expect(normalizeServerVersion('01')).toBe(normalizeServerVersion('1'));
    expect(normalizeServerVersion('v01_00')).toBe('1.0');
  });

  it('formats and parses version path segments', () => {
    expect(serverVersionPathSegment('01')).toBe('v1');
    expect(serverVersionPathSegment('2.0.6')).toBe('v2_0_6');
    expect(serverVersionFromPathSegment('v2_0_6')).toBe('2.0.6');
    expect(serverVersionFromPathSegment('v01_00')).toBe('1.0');
    expect(serverVersionFromPathSegment('2_0_6')).toBeUndefined();
  });

  it('rejects unsupported or unsafe versions', () => {
    for (const value of ['', 'latest', '2.0.6-beta', '../2', '1.2.3.4']) {
      expect(() => normalizeServerVersion(value)).toThrow(/invalid server version/);
    }
  });

  it('sorts numerically instead of lexicographically', () => {
    expect(compareServerVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareServerVersions('1.10', '1.2')).toBeGreaterThan(0);
    expect(compareServerVersions('1', '1.0.0')).toBe(0);
  });
});

describe('tenant MCP route helpers', () => {
  it('formats public MCP URLs from an explicit organization subdomain', () => {
    expect(
      formatPublicMcpUrl('https://cloud.noodleseed.dev', {
        mcpSubdomain: 'arez',
        app: 'todoist',
        env: 'prod',
        serverVersion: '1',
      }),
    ).toBe('https://arez.cloud.noodleseed.dev/todoist/v1/mcp');

    expect(
      formatPublicMcpUrl('cloud.noodleseed.dev', {
        mcpSubdomain: 'arez',
        app: 'todoist',
        env: 'staging',
        serverVersion: '2.0.6',
      }),
    ).toBe('https://arez.cloud.noodleseed.dev/todoist/env/staging/v2_0_6/mcp');
  });

  it('parses public MCP URLs without treating the subdomain as an org slug', () => {
    expect(
      parsePublicMcpUrl('https://arez.cloud.noodleseed.dev/todoist/v1/mcp', [
        'cloud.noodleseed.dev',
      ]),
    ).toEqual({
      mcpSubdomain: 'arez',
      app: 'todoist',
      env: 'prod',
      serverVersion: '1',
    });

    expect(
      parsePublicMcpUrl('https://arez.cloud.noodleseed.dev/todoist/env/staging/v2_0_6/mcp', [
        'cloud.noodleseed.dev',
      ]),
    ).toEqual({
      mcpSubdomain: 'arez',
      app: 'todoist',
      env: 'staging',
      serverVersion: '2.0.6',
    });
  });

  it('rejects unsafe public MCP URLs', () => {
    for (const value of [
      'https://cloud.noodleseed.dev/todoist/v1/mcp',
      'https://local.cloud.noodleseed.dev/todoist/v1/mcp',
      'https://saad-apps.evil.test/todoist/v1/mcp',
      'https://team.saad-apps.cloud.noodleseed.dev/todoist/v1/mcp',
      'https://saad-apps.cloud.noodleseed.dev/todoist/latest/mcp',
      'https://saad-apps.cloud.noodleseed.dev/todoist/vlatest/mcp',
      'https://saad-apps.cloud.noodleseed.dev/../todoist/v1/mcp',
    ]) {
      expect(parsePublicMcpUrl(value, ['cloud.noodleseed.dev'])).toBeUndefined();
    }
  });

  it('accepts only byte-exact canonical public and legacy resource URLs', () => {
    expect(
      parseCanonicalPublicMcpUrl('https://arez.cloud.noodleseed.dev/todoist/v1/mcp', [
        'cloud.noodleseed.dev',
      ]),
    ).toMatchObject({ mcpSubdomain: 'arez', app: 'todoist', serverVersion: '1' });
    expect(
      parseCanonicalPublicMcpUrl('https://AREZ.cloud.noodleseed.dev/todoist/v1/mcp', [
        'cloud.noodleseed.dev',
      ]),
    ).toBeUndefined();
    expect(
      parseCanonicalLegacyTenantMcpUrl(
        'https://service.noodleseed.dev/o/acme/todoist/staging/v2_0/mcp',
        'https://service.noodleseed.dev',
      ),
    ).toMatchObject({ org: 'acme', app: 'todoist', env: 'staging', serverVersion: '2.0' });
    expect(
      parseCanonicalLegacyTenantMcpUrl(
        'https://other.example/o/acme/todoist/mcp',
        'https://service.noodleseed.dev',
      ),
    ).toBeUndefined();
  });

  it('keeps legacy MCP path parsing compatible', () => {
    expect(parseLegacyTenantMcpPath('/o/acme/hello/v2_0_6/mcp')).toEqual({
      org: 'acme',
      app: 'hello',
      env: 'prod',
      serverVersion: '2.0.6',
    });
    expect(parseLegacyTenantMcpPath('/o/acme/hello/staging/v1/mcp')).toEqual({
      org: 'acme',
      app: 'hello',
      env: 'staging',
      serverVersion: '1',
    });
    expect(parseLegacyTenantMcpPath('/o/local/hello/mcp')).toEqual({
      org: 'local',
      app: 'hello',
      env: 'prod',
    });
  });
});

describe('public org well-known route helpers', () => {
  it('parses the OpenAI Apps challenge URL as an MCP subdomain', () => {
    expect(
      parsePublicOrgWellKnownUrl(
        `https://saad-test.cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}`,
        ['cloud.noodleseed.dev'],
        OPENAI_APPS_CHALLENGE_PATH,
      ),
    ).toEqual({ mcpSubdomain: 'saad-test' });
  });

  it('rejects malformed org well-known URLs', () => {
    for (const value of [
      `http://saad-test.cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}`,
      `https://cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}`,
      `https://local.cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}`,
      `https://team.saad-test.cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}`,
      `https://saad-test.evil.test${OPENAI_APPS_CHALLENGE_PATH}`,
      `https://saad-test.cloud.noodleseed.dev${OPENAI_APPS_CHALLENGE_PATH}?token=1`,
      'https://saad-test.cloud.noodleseed.dev/.well-known/oauth-authorization-server',
      'https://saad-test.cloud.noodleseed.dev/%2e%2e/.well-known/openai-apps-challenge',
    ]) {
      expect(
        parsePublicOrgWellKnownUrl(value, ['cloud.noodleseed.dev'], OPENAI_APPS_CHALLENGE_PATH),
      ).toBeUndefined();
    }
  });
});
