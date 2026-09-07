import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryAssetStore,
  InMemoryControlPlaneStore,
  type RunningService,
  serveService,
} from '@noodle-borg/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
/**
 * End-to-end B3 acceptance: a *linked* project deploys packaged assets to a real (in-process) service
 * with no asset flags, no bucket/object-key/CDN knowledge — over the real HTTP wire (preflight →
 * signed upload → deploy), exercising the CLI's own fetch path. The in-memory store's upload URLs
 * route back to the service, so a real `fetch` PUT reaches it.
 */
describe.sequential('noodle deploy — linked managed asset deploy (B3 acceptance)', () => {
  let cwd: string;
  let home: string;
  let tmp: string;
  let svc: RunningService;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-asset-e2e-home-'));
    tmp = mkdtempSync(join(tmpdir(), 'noodle-asset-e2e-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrg({ slug: 'acme' });
    svc = await serveService({
      port: 0,
      controlPlaneStore: controlPlane,
      assetStore: new InMemoryAssetStore(),
      assetPublicBaseUrl: 'https://assets.example.test',
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { subject: 'owner-sub' } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
  });
  afterEach(async () => {
    process.chdir(cwd);
    logSpy.mockRestore();
    await svc.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  function writeProject(): void {
    mkdirSync(join(tmp, 'assets'));
    writeFixtureWidget(tmp);
    writeFileSync(join(tmp, 'assets', 'logo.png'), PNG_1X1);
    writeFileSync(
      join(tmp, 'server.ts'),
      `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');
export default server('assets_app', { title: 'Assets App', version: '1.0.0', branding: { logo: { uri: logo, alt: 'logo' } } }, [
  tool('show', { description: 'Show.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }), viewTitle: 'A', view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' } }),
]);
`,
    );
  }
  it('uploads on first deploy and reuses on redeploy, with no asset flags', async () => {
    writeProject();
    process.chdir(tmp);
    expect(
      await run(['link', '--org', 'acme', '--app', 'assets', '--service', svc.url], {}, home),
    ).toBe(0);
    expect(await run(['deploy', '--version', '1', '--no-save'], {}, home)).toBe(0);
    const first = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(first).toContain('Assets:');
    expect(first).toContain('1 checked, 1 uploaded, 0 reused');
    expect(first).toContain('Dashboard: unavailable for this service; use the CLI to operate it.');
    expect(first).not.toContain(`${svc.url}/projects/acme/assets`);
    expect(first).toContain('Next:      noodle logs --tail');
    expect(first).toContain('Next:      noodle smoke');
    expect(first).toContain('Next:      noodle connect claude-code');
    logSpy.mockClear();
    expect(await run(['deploy', '--version', '1', '--no-save'], {}, home)).toBe(0);
    const second = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(second).toContain('1 checked, 0 uploaded, 1 reused');
  });

  it('preflights an asset-bearing project over real HTTP without uploading or creating hosted state', async () => {
    writeProject();
    process.chdir(tmp);
    const requests = vi.spyOn(globalThis, 'fetch');
    try {
      expect(
        await run(
          [
            'deploy',
            'preflight',
            'server.ts',
            '--org',
            'acme',
            '--app',
            'assets',
            '--env',
            'staging',
            '--version',
            '1',
            '--service',
            svc.url,
            '--auth-token',
            'OWNER',
            '--json',
          ],
          { NOODLE_UPDATE_MODE: 'off' },
          home,
        ),
      ).toBe(0);
      const output = JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n'));
      expect(output).toMatchObject({
        ok: true,
        data: {
          ready: true,
          published: false,
          serverVersion: '1',
          target: { appState: 'will-create', environmentState: 'will-create' },
        },
      });
      expect(requests.mock.calls.map(([url]) => String(url))).toEqual([
        `${svc.url}/v1/orgs/acme/apps/assets/envs/staging/deploy/preflight`,
      ]);
      expect(await svc.registry.getApp('acme', 'assets')).toBeUndefined();
      expect(await svc.registry.getEnvironment('acme', 'assets', 'staging')).toBeUndefined();
      expect(existsSync(join(tmp, '.noodle'))).toBe(false);
    } finally {
      requests.mockRestore();
    }
  });
});

function writeFixtureWidget(root: string): void {
  mkdirSync(join(root, 'views'));
  writeFileSync(
    join(root, 'views', 'FixtureWidget.tsx'),
    'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
  );
}
