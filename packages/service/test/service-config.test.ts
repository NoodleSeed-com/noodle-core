import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defineNoodleService,
  expandServiceProfile,
  parseNoodleServiceYaml,
  resolveServiceConfigSource,
  serveService,
} from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'service-configs');

describe('service capability profiles and config', () => {
  it('expands canonical profiles to capability defaults', () => {
    expect(expandServiceProfile('open-core')).toEqual(['observability', 'secrets', 'connectors']);
    expect(expandServiceProfile('enterprise-governed')).toEqual([
      'identity',
      'access',
      'controls',
      'audit',
      'observability',
      'secrets',
      'connectors',
    ]);
    expect(expandServiceProfile('agency-managed')).toEqual([
      'identity',
      'access',
      'controls',
      'audit',
      'observability',
      'secrets',
      'connectors',
      'apps',
    ]);
  });

  it('parses YAML config and applies explicit capability overrides', () => {
    const parsed = parseNoodleServiceYaml(`
profile: enterprise-governed

audit:
  enabled: false

apps:
  enabled: true
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.profile).toBe('enterprise-governed');
    expect(parsed.capabilities).toContain('apps');
    expect(parsed.capabilities).not.toContain('audit');
  });

  it('rejects unknown profiles with valid suggestions', () => {
    const parsed = parseNoodleServiceYaml('profile: enterprise\n');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('unknown service profile "enterprise"');
    expect(parsed.error).toContain('enterprise-governed');
  });

  it('keeps TypeScript service config typed for advanced operators', () => {
    const config = defineNoodleService({
      profile: 'agency-managed',
      audit: { store: 'postgres', mode: 'observe' },
      observability: {
        enabled: true,
        logs: { level: 'debug', sink: 'stderr', format: 'json' },
        otel: { enabled: false },
        sentry: { enabled: false },
        userAppLogs: { enabled: true, retentionDays: 7, maxEventsPerExecution: 100 },
      },
      modules: [],
    });

    expect(config.profile).toBe('agency-managed');
    expect(config.audit?.store).toBe('postgres');
    expect(config.audit?.mode).toBe('observe');
    expect(config.observability?.logs?.sink).toBe('stderr');
    expect(config.observability?.userAppLogs?.retentionDays).toBe(7);
  });

  it('parses explicit observability config and rejects invalid values', () => {
    const parsed = parseNoodleServiceYaml(`
profile: open-core
observability:
  enabled: true
  logs:
    level: debug
    sink: stderr
    format: json
    samplingRate: 0.5
  otel:
    enabled: true
    endpoint: https://otel.example/v1/traces
  sentry:
    enabled: true
  userAppLogs:
    enabled: true
    retentionDays: 14
    maxEventsPerExecution: 250
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.observability?.logs?.level).toBe('debug');
    expect(parsed.config.observability?.otel?.endpoint).toBe('https://otel.example/v1/traces');
    expect(parsed.config.observability?.userAppLogs?.maxEventsPerExecution).toBe(250);

    const invalid = parseNoodleServiceYaml(`
profile: open-core
observability:
  logs:
    level: noisy
`);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error).toContain('unknown observability log level "noisy"');
  });

  it('parses explicit audit mode and rejects invalid audit config', () => {
    const parsed = parseNoodleServiceYaml(`
profile: open-core
audit:
  enabled: true
  store: postgres
  mode: enforce
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.audit).toEqual({ enabled: true, store: 'postgres', mode: 'enforce' });
    expect(parsed.capabilities).toContain('audit');

    const invalidMode = parseNoodleServiceYaml(`
profile: open-core
audit:
  mode: strict
`);
    expect(invalidMode.ok).toBe(false);
    if (invalidMode.ok) return;
    expect(invalidMode.error).toContain('unknown audit mode "strict"');
  });

  it('fails closed when YAML and TypeScript configs both exist without explicit source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noodle-service-config-'));
    writeFileSync(join(dir, 'noodle.service.yaml'), 'profile: open-core\n');
    writeFileSync(join(dir, 'noodle.service.ts'), 'export default {};\n');
    try {
      expect(resolveServiceConfigSource({ dir }).ok).toBe(false);
      await expect(serveService({ serviceConfigDir: dir })).rejects.toThrow(
        /choose one service config source/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates audience workflow service config fixtures', () => {
    const cases = [
      {
        file: 'noodle-cloud-managed.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'observability',
          'secrets',
          'connectors',
          'apps',
        ],
      },
      {
        file: 'enterprise-governed.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'audit',
          'observability',
          'secrets',
          'connectors',
        ],
      },
      {
        file: 'public-saas.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'audit',
          'observability',
          'secrets',
          'connectors',
          'apps',
        ],
      },
      {
        file: 'agency-small-business.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'audit',
          'observability',
          'secrets',
          'connectors',
          'apps',
        ],
      },
      {
        file: 'agency-mid-market.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'audit',
          'observability',
          'secrets',
          'connectors',
          'apps',
        ],
      },
      {
        file: 'agency-enterprise.yaml',
        capabilities: [
          'identity',
          'access',
          'controls',
          'audit',
          'observability',
          'secrets',
          'connectors',
          'apps',
        ],
      },
    ] as const;

    for (const entry of cases) {
      const parsed = parseNoodleServiceYaml(readFileSync(join(FIXTURES, entry.file), 'utf8'));
      expect(parsed.ok, entry.file).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.capabilities, entry.file).toEqual(entry.capabilities);
    }
  });

  it('rejects unknown agency workflow templates', () => {
    const parsed = parseNoodleServiceYaml(
      readFileSync(join(FIXTURES, 'agency-invalid-template.yaml'), 'utf8'),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('unknown org template "custom-dynamic"');
  });
});

describe('serveService — asset store wiring (P1.5 B1)', () => {
  const ASSET_ENV = [
    'NOODLE_ASSET_ADAPTER',
    'NOODLE_ASSET_BUCKET',
    'NOODLE_ASSET_PUBLIC_BASE_URL',
  ] as const;

  async function withAssetEnv(
    env: Partial<Record<(typeof ASSET_ENV)[number], string>>,
    run: () => Promise<void>,
  ): Promise<void> {
    const prev = ASSET_ENV.map((key) => [key, process.env[key]] as const);
    for (const key of ASSET_ENV) delete process.env[key];
    Object.assign(process.env, env);
    try {
      await run();
    } finally {
      for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('boots with the in-memory asset fake by default (local/self-hosted, no asset env)', async () => {
    await withAssetEnv({}, async () => {
      const running = await serveService({ host: '127.0.0.1', port: 0 });
      try {
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      } finally {
        await running.close();
      }
    });
  });
});
