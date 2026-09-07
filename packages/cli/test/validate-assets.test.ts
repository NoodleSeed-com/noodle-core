import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, validate } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
/** A linked project that packages one logo image referenced from branding + a widget. */
function writeAssetProject(): {
  root: string;
  authored: string;
} {
  const root = mkdtempSync(join(tmpdir(), `noodle-validate-assets-${process.pid}-`));
  mkdirSync(join(root, 'assets'));
  writeFixtureWidget(root);
  writeFileSync(join(root, 'assets', 'logo.png'), PNG_1X1);
  const authored = join(root, 'server.ts');
  writeFileSync(
    authored,
    `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

export default server(
  'asset_validate',
  {
    title: 'Asset Validate',
    version: '1.0.0',
    branding: { logo: { uri: logo, alt: 'logo' } },
  },
  [
    tool(
      'show',
      {
        description: 'Show.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        fulfil: () => ({ ok: true }),
        viewTitle: 'Asset',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ),
  ],
);
`,
  );
  return { root, authored };
}
describe('validate() packaged asset disclosure', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  it('lists packaged assets that will become public web assets', async () => {
    const project = writeAssetProject();
    root = project.root;
    const outcome = await validate({ manifestPath: project.authored });
    expect(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome)).toBe(true);
    expect(outcome.ok && outcome.assets).toEqual([
      { sourcePath: 'assets/logo.png', mimeType: 'image/png', byteLength: PNG_1X1.byteLength },
    ]);
  });
  it('omits the assets field for an app with no packaged assets', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), `noodle-validate-noassets-${process.pid}-`));
    root = projectRoot;
    writeFixtureWidget(projectRoot);
    const authored = join(projectRoot, 'server.ts');
    writeFileSync(
      authored,
      `
import { server, tool, z } from '@noodleseed/one';

export default server('plain', { title: 'Plain', version: '1.0.0' }, [
  tool('show', { description: 'Show.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }), viewTitle: 'Plain', view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' } }),
]);
`,
    );
    const outcome = await validate({ manifestPath: authored });
    expect(outcome.ok && outcome.assets).toBeUndefined();
  });
});

function writeFixtureWidget(root: string): void {
  mkdirSync(join(root, 'views'));
  writeFileSync(
    join(root, 'views', 'FixtureWidget.tsx'),
    'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
  );
}
describe('noodle validate — asset disclosure output', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });
  it('prints a public-asset disclosure block naming each packaged file', async () => {
    const project = writeAssetProject();
    try {
      expect(await run(['validate', project.authored])).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('Packaged assets');
      expect(printed).toContain('public');
      expect(printed).toContain('assets/logo.png');
    } finally {
      rmSync(project.root, { recursive: true, force: true });
    }
  });
});
