import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAssetStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const ASSET_SERVER = `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

export default server('asset_app', {
  title: 'Asset App',
  version: '1.0.0',
  branding: { logo: { uri: logo, alt: 'Asset app logo' } },
}, [
  tool(
    'show',
    {
      description: 'Show an asset.',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      fulfil: () => ({ ok: true }),
      viewTitle: 'Asset',
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    },
  ),
]);
`;
let service: RunningService;
beforeAll(async () => {
  service = await serveService({
    port: 0,
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
    assetStore: new InMemoryAssetStore(),
  });
});
afterAll(async () => {
  await service.close();
});
describe('noodle doctor packaged asset readiness', () => {
  let home: string;
  let dir: string;
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-cli-doctor-home-'));
    dir = mkdtempSync(join(tmpdir(), 'noodle-cli-doctor-assets-'));
    cwd = process.cwd();
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    logSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  it('reports packaged asset readiness for linked projects with assets', async () => {
    writeConfig(
      {
        serviceUrl: service.url,
        authToken: 'OWNER',
        identity: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
      },
      home,
    );
    writeAssetProject(dir);
    expect(
      await run(
        [
          'link',
          '--org',
          'acme',
          '--app',
          'asset-app',
          '--service',
          service.url,
          '--entrypoint',
          'server.ts',
        ],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();
    expect(await run(['doctor'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/Assets\s+1 packaged asset\(s\) preflight-ready/);
    expect(printed).toContain('assets/logo.png');
    const assetLine = printed
      .split('\n')
      .find((line) => line.includes('packaged asset(s) preflight-ready')) as string;
    expect(assetLine).not.toContain(dir);
  }, 30_000);
});
function writeAssetProject(dir: string): void {
  writeFileSync(join(dir, 'server.ts'), ASSET_SERVER);
  writeFixtureWidget(dir);
  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir);
  writeFileSync(
    join(assetsDir, 'logo.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
}

function writeFixtureWidget(root: string): void {
  mkdirSync(join(root, 'views'));
  writeFileSync(
    join(root, 'views', 'FixtureWidget.tsx'),
    'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
  );
}
