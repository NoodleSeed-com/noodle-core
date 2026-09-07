import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReactWidgetViews } from '../src/react-widget-build.js';
import { widgetFiles } from '../src/widget-scaffold-template.js';
import {
  widgetShowcaseHelpers,
  widgetShowcaseSections,
  widgetShowcaseView,
} from '../src/widget-showcase-template.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

let browser: Browser;
let compiledHtml = '';
let preferencesHtml = '';
let projectDir = '';
let previousBuilderRoot: string | undefined;

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'noodle-widget-showcase-'));
  for (const [relativePath, content] of Object.entries(widgetFiles('design-system-showcase', []))) {
    const path = join(projectDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  previousBuilderRoot = process.env.NOODLE_BUILDER_VITE_ROOT;
  process.env.NOODLE_BUILDER_VITE_ROOT = repoRoot;
  const preferences = JSON.parse(
    await buildReactWidgetViews(
      JSON.stringify({
        name: 'preferences',
        version: '1.0.0',
        tools: [],
        widgets: [
          {
            title: 'Notification preferences',
            view: { component: 'preferences-card', entry: './src/views/preferences-card.tsx' },
          },
        ],
      }),
      { rootDir: projectDir },
    ),
  ) as { widgets: { view: { compiledHtml: string } }[] };
  preferencesHtml = preferences.widgets[0]?.view.compiledHtml ?? '';
  expect(preferencesHtml).toContain('data-noodle-react-bundle');
  writeFileSync(join(projectDir, 'src/helpers.ts'), widgetShowcaseHelpers);
  writeFileSync(join(projectDir, 'src/views/design-system-showcase.tsx'), widgetShowcaseView);
  writeFileSync(join(projectDir, 'src/views/showcase-sections.tsx'), widgetShowcaseSections);
  const built = JSON.parse(
    await buildReactWidgetViews(
      JSON.stringify({
        name: 'design_system_showcase',
        version: '1.0.0',
        tools: [],
        widgets: [
          {
            title: 'Noodle React design system',
            view: {
              component: 'design-system-showcase',
              entry: './src/views/design-system-showcase.tsx',
            },
          },
        ],
      }),
      { rootDir: projectDir },
    ),
  ) as { widgets?: readonly { view?: { compiledHtml?: string } }[] };
  compiledHtml = built.widgets?.[0]?.view?.compiledHtml ?? '';
  expect(compiledHtml).toContain('data-noodle-react-bundle');
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      'Widget showcase browser tests require Chromium. Run `pnpm exec playwright install chromium`.',
      { cause: error },
    );
  }
});

afterAll(async () => {
  await browser?.close();
  if (previousBuilderRoot === undefined) delete process.env.NOODLE_BUILDER_VITE_ROOT;
  else process.env.NOODLE_BUILDER_VITE_ROOT = previousBuilderRoot;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('generated widget design-system showcase', () => {
  it('renders the unchanged generated preference view as an honest preview with a single pending call', async () => {
    const app = await openShowcase({ width: 320, height: 760, focused: true });
    try {
      const { frame } = app;
      expect(
        await frame.getByText('Synthetic preview only. No customer preference is saved.').count(),
      ).toBe(1);
      const action = frame.getByRole('button', { name: 'Preview preference', exact: true });
      await frame.locator('select').selectOption('sms');
      await action.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect
        .poll(() => frame.getByText('Previewing your preference…', { exact: true }).count())
        .toBe(1);
      expect(await action.count()).toBe(0);
      await frame.evaluate(() => globalThis.dispatchEvent(new Event('fixture-complete')));
      await expect
        .poll(() => frame.getByText('Preview: sms; not saved.', { exact: true }).count())
        .toBe(1);
      expect(await frame.locator('[data-fixture-calls]').getAttribute('data-fixture-calls')).toBe(
        '1',
      );
      expect(await frame.locator('[data-llm]').getAttribute('data-llm')).toBe(
        'Preview: sms; not saved.',
      );
      expect(await frame.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
      await frame.evaluate(() => {
        document.body.dataset.fixtureError = 'true';
      });
      await action.click();
      await expect
        .poll(() => frame.getByText('Previewing your preference…', { exact: true }).count())
        .toBe(1);
      await frame.evaluate(() => globalThis.dispatchEvent(new Event('fixture-complete')));
      await expect
        .poll(() =>
          frame
            .getByText('Could not verify the preview. Inspect the local result before retrying.', {
              exact: true,
            })
            .count(),
        )
        .toBe(1);
      expect(await frame.getByText('Preview: sms; not saved.', { exact: true }).count()).toBe(0);
    } finally {
      await app.context.close();
    }
  });
  it('renders every category and its interactive examples', async () => {
    const app = await openShowcase({ width: 920, height: 900 });
    try {
      const { frame, page } = app;
      expect(await frame.locator('.nsr-view-nav-item').allTextContents()).toEqual([
        'Foundations',
        'Forms',
        'Data display',
        'Feedback',
        'Overlays',
        'Layouts',
      ]);
      expect(await frame.getByText('Primary', { exact: true }).count()).toBeGreaterThan(0);
      expect(await frame.locator('.nsr-avatar').count()).toBe(4);

      await frame.getByRole('button', { name: 'Forms' }).click();
      await frame.locator('input[name="email"]').waitFor();
      expect(await frame.locator('input[role="switch"]').count()).toBe(1);
      expect(await frame.locator('.nsr-segmented').count()).toBeGreaterThanOrEqual(2);

      await frame.getByRole('button', { name: 'Data display' }).click();
      await frame.getByText('Collections', { exact: true }).waitFor();
      expect(await frame.locator('.nsr-fact').count()).toBe(4);
      expect(await frame.locator('.nsr-collection-item').count()).toBe(3);

      await frame.getByRole('button', { name: 'Feedback' }).click();
      await frame.getByRole('button', { name: 'Run tool' }).click();
      await expect
        .poll(() => frame.getByText('The demo tool returned structured content.').count())
        .toBe(1);

      await frame.getByRole('button', { name: 'Overlays' }).click();
      await frame.getByRole('button', { name: 'Open modal' }).click();
      await expect.poll(() => frame.locator('[role="dialog"]').count()).toBe(1);
      await page.keyboard.press('Escape');
      await expect.poll(() => frame.locator('[role="dialog"]').count()).toBe(0);

      await frame.getByRole('button', { name: 'Layouts' }).click();
      await frame.getByText('InlineCarousel', { exact: true }).waitFor();
      expect(await frame.locator('.nsr-inline-carousel-item').count()).toBe(3);

      await frame.locator('.nsr-segmented-label').filter({ hasText: 'AppShell' }).click();
      await expect.poll(() => frame.locator('.nsr-shell').count()).toBe(1);
      await frame.locator('.nsr-segmented-label').filter({ hasText: 'FullscreenShell' }).click();
      await expect.poll(() => frame.locator('.nsr-fullscreen-shell').count()).toBe(1);
    } finally {
      await app.context.close();
    }
  });

  it('reflows without horizontal overflow in a narrow dark host', async () => {
    const app = await openShowcase({ width: 320, height: 760, theme: 'dark' });
    try {
      expect(
        await app.frame.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
      ).toEqual({ clientWidth: 320, scrollWidth: 320 });
      expect(
        await app.frame.locator('.nsr-view-nav-segmented').evaluate((node) => ({
          containsOverflow: node.scrollWidth > node.clientWidth,
          overflowX: getComputedStyle(node).overflowX,
        })),
      ).toEqual({ containsOverflow: true, overflowX: 'auto' });
      expect(await app.frame.locator('.nsr-frame').getAttribute('data-display-mode')).toBe(
        'fullscreen',
      );
      expect(
        await app.frame
          .locator('.nsr-frame-surface')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe('rgb(33, 33, 33)');
    } finally {
      await app.context.close();
    }
  });
});

async function openShowcase(options: {
  readonly width: number;
  readonly height: number;
  readonly theme?: 'light' | 'dark';
  readonly focused?: boolean;
}): Promise<{ context: BrowserContext; page: Page; frame: Frame }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    hasTouch: options.width <= 480,
  });
  const page = await context.newPage();
  await page.setContent(
    '<iframe title="MCP App" sandbox="allow-scripts" style="border:0;width:100vw;height:100vh"></iframe>',
  );
  const theme = options.theme ?? 'light';
  const layout = {
    theme,
    displayMode: options.width <= 320 ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    locale: 'en-US',
    platform: options.width <= 480 ? 'mobile' : 'web',
    deviceCapabilities: { touch: options.width <= 480, hover: options.width > 480 },
  };
  const bridge = `<script>
    let viewState = {};
    const layout = ${JSON.stringify(layout)};
    const toolResult = { structuredContent: ${
      options.focused
        ? JSON.stringify({ channel: 'email', summary: 'Synthetic current preference.', demo: true })
        : `{
      title: 'Noodle React design system',
      version: '1.0.0',
      description: 'Interactive reference for host-neutral MCP Apps components.'
    }`
    }};
    globalThis.__noodleReactBridge = {
      getToolResult: () => toolResult,
      getViewState: () => viewState,
      setWidgetState: (patch) => {
        viewState = patch || {};
        globalThis.__noodleReactVersion = (globalThis.__noodleReactVersion || 0) + 1;
        globalThis.dispatchEvent(new CustomEvent('noodle:state'));
      },
      getLayout: () => layout,
      callServerTool: ${
        options.focused
          ? `async (request) => {
        document.body.dataset.fixtureCalls = String(Number(document.body.dataset.fixtureCalls || 0) + 1);
        await new Promise((resolve) => globalThis.addEventListener('fixture-complete', resolve, { once: true }));
        return { isError: document.body.dataset.fixtureError === 'true', structuredContent: { channel: request.arguments.channel, summary: 'Preview: ' + request.arguments.channel + '; not saved.', demo: true } };
      }`
          : `async (request) => ({ structuredContent: {
        ok: true,
        summary: 'Ran ' + request.name + ' successfully.'
      }})`
      },
      requestDisplayMode: async () => undefined,
      openExternal: async () => undefined,
      sendFollowUpMessage: async () => undefined
    };
  </script>`;
  const html = (options.focused ? preferencesHtml : compiledHtml)
    .replace('<html>', `<html data-theme="${theme}">`)
    .replace('<body>', `<body>${bridge}`);
  await page.locator('iframe').evaluate((node, content) => {
    (node as HTMLIFrameElement).srcdoc = content;
  }, html);
  await expect.poll(() => page.frames().length).toBe(2);
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error('sandboxed showcase frame did not load');
  await frame.waitForSelector('[data-llm]');
  return { context, page, frame };
}
