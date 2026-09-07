import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReactWidgetViews, reactWidgetWatchDirectories } from '../src/react-widget-build.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

let tmp: string;
let previousBuilderViteRoot: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noodle-react-widget-build-'));
  previousBuilderViteRoot = process.env.NOODLE_BUILDER_VITE_ROOT;
});

afterEach(() => {
  if (previousBuilderViteRoot === undefined) delete process.env.NOODLE_BUILDER_VITE_ROOT;
  else process.env.NOODLE_BUILDER_VITE_ROOT = previousBuilderViteRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildReactWidgetViews', () => {
  it('discovers distinct widget source directories for dev hot reload', () => {
    const projectDir = join(tmp, 'project');
    const viewsDir = join(projectDir, 'views');
    const nestedDir = join(viewsDir, 'nested');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(viewsDir, 'First.tsx'), 'export default function First() { return null; }');
    writeFileSync(
      join(viewsDir, 'Second.tsx'),
      'export default function Second() { return null; }',
    );
    writeFileSync(join(nestedDir, 'Third.tsx'), 'export default function Third() { return null; }');

    expect(
      reactWidgetWatchDirectories(
        JSON.stringify({
          widgets: [
            { view: { component: 'First', entry: './views/First.tsx' } },
            { view: { component: 'Second', entry: './views/Second.tsx' } },
            { view: { component: 'Third', entry: './views/nested/Third.tsx' } },
          ],
        }),
        { rootDir: projectDir },
      ),
    ).toEqual([nestedDir, viewsDir].sort());
  });

  it('rejects intrinsic React forms without a submit handler', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
export default function Widget() {
  return <form><button type="submit">Save</button></form>;
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    await expect(
      buildReactWidgetViews(
        JSON.stringify({
          name: 'native_form',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Native form',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ).rejects.toThrow(/portable <Form>.*type="button"/i);
  });

  it('rejects intrinsic React forms with browser-navigation attributes', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
export default function Widget() {
  return <form action="/jobs" onSubmit={(event) => event.preventDefault()}><button type="submit">Save</button></form>;
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    await expect(
      buildReactWidgetViews(
        JSON.stringify({
          name: 'navigating_form',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Navigating form',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ).rejects.toThrow(/portable <Form>.*type="button"/i);
  });

  it('rejects intrinsic buttons whose native type is left implicit', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
export default function Widget() {
  return <button onClick={() => undefined}>Save</button>;
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    await expect(
      buildReactWidgetViews(
        JSON.stringify({
          name: 'implicit_button',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Implicit button',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ).rejects.toThrow(/explicit type="button" or type="submit"/i);
  });

  it('builds portable forms and explicit standalone action buttons', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
import { Form } from '@noodleseed/one/react';

export default function Widget() {
  return (
    <main>
      <Form onSubmit={() => undefined}>
        <button type="submit">Save form</button>
      </Form>
      <button type="button" onClick={() => undefined}>Save directly</button>
    </main>
  );
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    const built = JSON.parse(
      await buildReactWidgetViews(
        JSON.stringify({
          name: 'portable_actions',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Portable actions',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ) as { widgets?: readonly { view?: { compiledHtml?: string } }[] };

    const html = built.widgets?.[0]?.view?.compiledHtml ?? '';
    expect(html).toContain('data-noodle-react-bundle');
    expect(html).toContain('Save form');
    expect(html).toContain('Save directly');
  });

  it('rejects an intrinsic React form even when its handler cancels submission', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
import type { FormEvent } from 'react';
import { useCallTool } from '@noodleseed/one/react';

export default function Widget() {
  const createJob = useCallTool('create_job');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createJob.callTool({ title: 'Plumbing job' });
  }
  return <form onSubmit={submit}><button type="submit">Create job</button></form>;
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    await expect(
      buildReactWidgetViews(
        JSON.stringify({
          name: 'explicit_react_form',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Explicit React form',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ).rejects.toThrow(/portable <Form>.*type="button"/i);
  });

  it('uses the explicit builder Vite toolchain when the project has no local Vite install', async () => {
    const projectDir = join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(projectDir, 'Widget.tsx'),
      `
export default function Widget() {
  return <main data-testid="builder-vite-fallback">Builder Vite fallback</main>;
}
`,
    );
    process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;

    const built = JSON.parse(
      await buildReactWidgetViews(
        JSON.stringify({
          name: 'builder_vite_fallback',
          version: '1.0.0',
          tools: [],
          widgets: [
            {
              title: 'Builder Vite fallback',
              view: { component: 'Widget', entry: './Widget.tsx' },
            },
          ],
        }),
        { rootDir: projectDir },
      ),
    ) as { widgets?: readonly { view?: { compiledHtml?: string } }[] };

    const html = built.widgets?.[0]?.view?.compiledHtml ?? '';
    expect(html).toContain('data-noodle-react-bundle');
    expect(html).toContain('builder-vite-fallback');
  });
});
