import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEffectiveLocalTarget } from '../src/local-target.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'noodle-local-target-'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeGlobalTarget(home: string): void {
  mkdirSync(join(home, '.noodle'), { recursive: true });
  writeJson(join(home, '.noodle', 'config.json'), {
    defaultOrg: 'hosted-org',
    defaultApp: 'other-app',
    defaultEnv: 'prod',
  });
}

function writeProjectConfig(project: string, config: object): void {
  writeJson(join(project, 'noodle.json'), config);
}

describe('resolveEffectiveLocalTarget', () => {
  it('uses project app metadata and ignores saved global coordinates for an unlinked project', () => {
    const project = tempDir();
    const home = tempDir();
    const manifestPath = join(project, 'src', 'server.ts');
    writeProjectConfig(project, { name: 'Customer Auth Demo' });
    writeGlobalTarget(home);

    expect(resolveEffectiveLocalTarget({ cwd: project, home, manifestPath })).toEqual({
      target: { org: 'local', app: 'customer-auth-demo', env: 'dev' },
      mode: 'unlinked',
      sources: { org: 'local-default', app: 'project', env: 'local-default' },
      ignoredSavedTarget: true,
    });
  });

  it('prefers noodle.json app over name and slug-normalizes it', () => {
    const project = tempDir();
    const home = tempDir();
    writeProjectConfig(project, { app: 'My Preferred App!', name: 'Ignored Name' });

    expect(
      resolveEffectiveLocalTarget({ cwd: project, home, manifestPath: join(project, 'server.ts') }),
    ).toEqual({
      target: { org: 'local', app: 'my-preferred-app', env: 'dev' },
      mode: 'unlinked',
      sources: { org: 'local-default', app: 'project', env: 'local-default' },
      ignoredSavedTarget: false,
    });
  });

  it.each([
    'server.ts',
    'index.ts',
    'manifest.yaml',
  ])('uses the containing project as the fallback app for %s', (filename) => {
    const parent = tempDir();
    const project = join(parent, 'Containing Project');
    const home = tempDir();
    const manifestPath =
      filename === 'manifest.yaml' ? join(project, filename) : join(project, 'src', filename);
    mkdirSync(join(project, 'src'), { recursive: true });
    writeProjectConfig(project, {});

    expect(resolveEffectiveLocalTarget({ cwd: project, home, manifestPath })).toEqual({
      target: { org: 'local', app: 'containing-project', env: 'dev' },
      mode: 'unlinked',
      sources: { org: 'local-default', app: 'local-default', env: 'local-default' },
      ignoredSavedTarget: false,
    });
  });

  it.each([
    'mcp/server.ts',
    'deploy.ts',
  ])('uses the project directory when %s derives a reserved app slug', (entrypoint) => {
    const parent = tempDir();
    const project = join(parent, 'Support Project');
    const home = tempDir();
    const manifestPath = join(project, entrypoint);
    mkdirSync(join(project, 'mcp'), { recursive: true });
    writeProjectConfig(project, { entrypoint });

    expect(resolveEffectiveLocalTarget({ cwd: project, home, manifestPath })).toEqual({
      target: { org: 'local', app: 'support-project', env: 'dev' },
      mode: 'unlinked',
      sources: { org: 'local-default', app: 'local-default', env: 'local-default' },
      ignoredSavedTarget: false,
    });
  });

  it('does not rewrite an explicitly configured reserved app name', () => {
    const project = tempDir();
    const home = tempDir();
    writeProjectConfig(project, { name: 'mcp' });

    expect(
      resolveEffectiveLocalTarget({
        cwd: project,
        home,
        manifestPath: join(project, 'mcp', 'server.ts'),
      }),
    ).toMatchObject({
      target: { org: 'local', app: 'mcp', env: 'dev' },
      sources: { app: 'project' },
    });
  });

  it('uses a complete project link even when saved global defaults differ', () => {
    const project = tempDir();
    const home = tempDir();
    const manifestPath = join(project, 'src', 'server.ts');
    mkdirSync(join(project, '.noodle'), { recursive: true });
    writeProjectConfig(project, { name: 'Customer Auth Demo' });
    writeJson(join(project, '.noodle', 'project.json'), {
      entrypoint: 'src/server.ts',
      org: 'acme',
      app: 'support',
      env: 'prod',
      serviceUrl: 'https://borg.noodleseed.com',
      accessMode: 'customers',
    });
    writeGlobalTarget(home);

    expect(resolveEffectiveLocalTarget({ cwd: project, home, manifestPath })).toEqual({
      target: { org: 'acme', app: 'support', env: 'prod' },
      mode: 'linked',
      sources: { org: 'link', app: 'link', env: 'link' },
      ignoredSavedTarget: false,
    });
  });

  it.each([
    ['org', { org: 'Explicit Org' }, { org: 'explicit', app: 'link', env: 'link' }],
    ['app', { app: 'Explicit App' }, { org: 'link', app: 'explicit', env: 'link' }],
    ['env', { env: 'Explicit Env' }, { org: 'link', app: 'link', env: 'explicit' }],
  ] as const)('replaces only the %s link coordinate when explicitly specified', (_, explicit, sources) => {
    const project = tempDir();
    const home = tempDir();
    mkdirSync(join(project, '.noodle'), { recursive: true });
    writeProjectConfig(project, { name: 'Customer Auth Demo' });
    writeJson(join(project, '.noodle', 'project.json'), {
      entrypoint: 'src/server.ts',
      org: 'acme',
      app: 'support',
      env: 'prod',
      serviceUrl: 'https://borg.noodleseed.com',
      accessMode: 'customers',
    });

    const target = resolveEffectiveLocalTarget({
      cwd: project,
      home,
      manifestPath: join(project, 'src', 'server.ts'),
      ...explicit,
    });

    expect(target.target).toEqual({
      org: explicit.org === undefined ? 'acme' : 'explicit-org',
      app: explicit.app === undefined ? 'support' : 'explicit-app',
      env: explicit.env === undefined ? 'prod' : 'explicit-env',
    });
    expect(target.sources).toEqual(sources);
    expect(target.mode).toBe('linked');
    expect(target.ignoredSavedTarget).toBe(false);
  });

  it.each([
    { org: 'partial-hosted-org' },
    { env: 'partial-hosted-env' },
  ])('does not use partial noodle.json hosted coordinates: %j', (partial) => {
    const project = tempDir();
    const home = tempDir();
    writeProjectConfig(project, { app: 'Customer Auth Demo', ...partial });
    writeGlobalTarget(home);

    expect(
      resolveEffectiveLocalTarget({
        cwd: project,
        home,
        manifestPath: join(project, 'src', 'server.ts'),
      }),
    ).toEqual({
      target: { org: 'local', app: 'customer-auth-demo', env: 'dev' },
      mode: 'unlinked',
      sources: { org: 'local-default', app: 'project', env: 'local-default' },
      ignoredSavedTarget: true,
    });
  });

  it('does not report ignored saved coordinates when none are configured', () => {
    const project = tempDir();
    const home = tempDir();
    writeProjectConfig(project, { name: 'Customer Auth Demo' });

    expect(
      resolveEffectiveLocalTarget({
        cwd: project,
        home,
        manifestPath: join(project, 'src', 'server.ts'),
      }),
    ).toMatchObject({ ignoredSavedTarget: false });
  });
});
