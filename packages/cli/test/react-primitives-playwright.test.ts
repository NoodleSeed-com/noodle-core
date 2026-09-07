import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReactWidgetViews } from '../src/react-widget-build.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fixtureEntry = './packages/cli/test/fixtures/react-primitives-browser/Widget.tsx';

let browser: Browser;
let compiledHtml: string;

beforeAll(async () => {
  const built = JSON.parse(
    await buildReactWidgetViews(
      JSON.stringify({
        name: 'react_primitives_browser',
        version: '1.0.0',
        tools: [],
        widgets: [
          {
            title: 'React primitive browser fixture',
            view: { component: 'Widget', entry: fixtureEntry },
          },
        ],
      }),
      { rootDir: repoRoot },
    ),
  ) as { widgets?: readonly { view?: { compiledHtml?: string } }[] };
  compiledHtml = built.widgets?.[0]?.view?.compiledHtml ?? '';
  expect(compiledHtml).toContain('data-noodle-react-bundle');
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      'React primitive browser tests require Chromium. Run `pnpm exec playwright install chromium`.',
      { cause: error },
    );
  }
});

afterAll(async () => {
  await browser?.close();
});

describe('React primitives in a sandboxed MCP App iframe', () => {
  it('captures form intent before sandboxed native submission', async () => {
    const app = await openFixture({ width: 720, height: 820 });
    const consoleErrors: string[] = [];
    app.page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    try {
      const title = app.frame.locator('[data-testid="form-title"]');
      const submit = app.frame.locator('[data-testid="form-submit"]');
      const count = app.frame.locator('[data-testid="form-intents"]');

      await submit.click();
      expect(await count.textContent()).toBe('0');

      await title.fill('Plumbing job');
      await submit.click();
      await expect.poll(() => count.textContent()).toBe('1');

      await title.focus();
      await app.page.keyboard.press('Enter');
      await expect.poll(() => count.textContent()).toBe('2');

      await app.frame.locator('[data-testid="direct-action"]').click();
      await expect
        .poll(() => app.frame.locator('[data-testid="direct-actions"]').textContent())
        .toBe('1');
      expect(consoleErrors).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/blocked form submission/i)]),
      );
    } finally {
      await app.context.close();
    }
  });

  it('preserves field, keyboard, menu, popover, tooltip, and modal focus behavior', async () => {
    const app = await openFixture({ width: 720, height: 820 });
    try {
      const { frame, page } = app;
      const email = frame.locator('input[name="email"]');
      const labelFor = await frame
        .locator('.nsr-field-label')
        .filter({ hasText: 'Email' })
        .getAttribute('for');
      expect(labelFor).toBe(await email.getAttribute('id'));
      expect(await email.getAttribute('aria-describedby')).toBeTruthy();

      const switchControl = frame.locator('input[role="switch"]');
      await switchControl.focus();
      await page.keyboard.press('Space');
      expect(await switchControl.isChecked()).toBe(false);

      const list = frame.locator('.nsr-segmented-input[value="list"]');
      const grid = frame.locator('.nsr-segmented-input[value="grid"]');
      await list.focus();
      await page.keyboard.press('ArrowRight');
      expect(await grid.isChecked()).toBe(true);

      const menuTrigger = frame.locator('.nsr-menu-trigger');
      await menuTrigger.focus();
      await page.keyboard.press('ArrowDown');
      const menuItems = frame.locator('[role="menuitem"]');
      await expect.poll(() => menuItems.count()).toBe(3);
      expect(await menuItems.nth(0).evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => frame.evaluate(() => document.activeElement?.textContent?.trim()))
        .toBe('Delete');
      await page.keyboard.press('Escape');
      await expect.poll(() => frame.locator('[role="menu"]').count()).toBe(0);
      await expect
        .poll(() => menuTrigger.evaluate((node) => document.activeElement === node))
        .toBe(true);

      const popoverTrigger = frame.locator('.nsr-popover-trigger');
      await popoverTrigger.click();
      const popover = frame.locator('.nsr-popover-panel');
      await expect.poll(() => popover.count()).toBe(1);
      await frame.locator('[data-testid="popover-action"]').focus();
      await page.keyboard.press('Escape');
      await expect.poll(() => popover.count()).toBe(0);
      await expect
        .poll(() => popoverTrigger.evaluate((node) => document.activeElement === node))
        .toBe(true);

      const tooltipTrigger = frame.locator('[data-testid="tooltip-trigger"]');
      await tooltipTrigger.focus();
      await expect.poll(() => frame.locator('[role="tooltip"]').count()).toBe(1);
      await page.keyboard.press('Escape');
      await expect.poll(() => frame.locator('[role="tooltip"]').count()).toBe(0);

      const dialogTrigger = frame.locator('[data-testid="dialog-trigger"]');
      await dialogTrigger.click();
      const dialog = frame.locator('[role="dialog"]');
      await expect.poll(() => dialog.count()).toBe(1);
      expect(await dialog.getAttribute('aria-modal')).toBe('true');
      expect(await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement))).toBe(
        true,
      );
      for (let index = 0; index < 5; index += 1) await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement))).toBe(
        true,
      );
      await page.keyboard.press('Escape');
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => dialogTrigger.evaluate((node) => document.activeElement === node))
        .toBe(true);
    } finally {
      await app.context.close();
    }
  });

  it('keeps a menu portaled from a dialog above the modal layer', async () => {
    const app = await openFixture({ width: 720, height: 820 });
    try {
      const { frame } = app;
      await frame.locator('[data-testid="dialog-trigger"]').click({ timeout: 2_000 });
      const dialog = frame.locator('[role="dialog"]');
      await expect.poll(() => dialog.count()).toBe(1);
      const dialogMenuTrigger = dialog.locator('.nsr-menu-trigger');
      await dialogMenuTrigger.click({ timeout: 2_000 });
      const nestedMenu = frame.locator('[role="menu"]');
      await expect.poll(() => nestedMenu.count()).toBe(1);
      const stacking = await nestedMenu.evaluate(
        (node) => ({
          menu: Number(getComputedStyle(node).zIndex),
          dialog: Number(
            getComputedStyle(node.ownerDocument.querySelector('[role="dialog"]') as Element).zIndex,
          ),
        }),
        undefined,
        { timeout: 2_000 },
      );
      expect(stacking.menu).toBeGreaterThan(stacking.dialog);
    } finally {
      await app.context.close();
    }
  });

  it('stays within a narrow RTL iframe and carries dark/reduced-motion tokens through portals', async () => {
    const app = await openFixture({
      width: 320,
      height: 720,
      direction: 'rtl',
      theme: 'dark',
      fontScale: 2,
      reducedMotion: true,
    });
    try {
      const { frame, page } = app;
      expect(await frame.locator('[data-testid="fixture"]').getAttribute('data-display-mode')).toBe(
        'fullscreen',
      );
      expect(
        await frame.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(
        await frame
          .locator('.nsr-spinner')
          .evaluate((node) => getComputedStyle(node).animationName),
      ).toBe('none');

      const menuTrigger = frame.locator('.nsr-menu-trigger');
      expect((await menuTrigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
      await menuTrigger.focus();
      await page.keyboard.press('ArrowDown');
      const menu = frame.locator('[role="menu"]');
      await expect.poll(() => menu.count()).toBe(1);
      const geometry = await menu.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          viewport: node.ownerDocument.documentElement.clientWidth,
          background: getComputedStyle(node).backgroundColor,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.background).toBe('rgb(33, 33, 33)');
      const dangerContrast = await frame.locator('.nsr-menu-item-danger').evaluate((node) => {
        const parse = (color: string) =>
          (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => Number(part) / 255);
        const luminance = (color: string) => {
          const [red = 0, green = 0, blue = 0] = parse(color).map((channel) =>
            channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
          );
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const foreground = luminance(getComputedStyle(node).color);
        const menuElement = node.closest('[role="menu"]');
        if (!menuElement) return 0;
        const background = luminance(getComputedStyle(menuElement).backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
      expect(dangerContrast).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');

      await frame.locator('[data-testid="dialog-trigger"]').click();
      const dialog = frame.locator('[role="dialog"]');
      await expect.poll(() => dialog.count()).toBe(1);
      const centering = await dialog.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
          center: box.left + box.width / 2,
          viewportCenter: node.ownerDocument.documentElement.clientWidth / 2,
        };
      });
      expect(Math.abs(centering.center - centering.viewportCenter)).toBeLessThanOrEqual(1);
    } finally {
      await app.context.close();
    }
  });

  it('keeps focus indicators visible in forced-colors mode', async () => {
    const app = await openFixture({
      width: 480,
      height: 720,
      forcedColors: true,
    });
    try {
      const trigger = app.frame.locator('[data-testid="dialog-trigger"]');
      await trigger.focus();
      const outline = await trigger.evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: style.outlineWidth };
      });
      expect(outline.style).not.toBe('none');
      expect(outline.width).not.toBe('0px');
    } finally {
      await app.context.close();
    }
  });

  it('stays usable in a 280px minimized host', async () => {
    const app = await openFixture({ width: 280, height: 640 });
    try {
      expect(
        await app.frame.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      for (const action of await app.frame.locator('button:not([disabled])').all()) {
        expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
    } finally {
      await app.context.close();
    }
  });
});

async function openFixture(options: {
  readonly width: number;
  readonly height: number;
  readonly direction?: 'ltr' | 'rtl';
  readonly theme?: 'light' | 'dark';
  readonly fontScale?: number;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}): Promise<{ context: BrowserContext; page: Page; frame: Frame }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    hasTouch: options.width <= 480,
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
    forcedColors: options.forcedColors ? 'active' : 'none',
  });
  const page = await context.newPage();
  await page.setContent(
    '<iframe title="MCP App" sandbox="allow-scripts" style="border:0;width:100vw;height:100vh"></iframe>',
  );
  const direction = options.direction ?? 'ltr';
  const theme = options.theme ?? 'light';
  const fontScale = options.fontScale ?? 1;
  const layout = JSON.stringify({
    theme,
    displayMode: options.width <= 320 ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen', 'pip'],
    locale: direction === 'rtl' ? 'ar-PK' : 'en-US',
    platform: options.width <= 480 ? 'mobile' : 'web',
    deviceCapabilities: { touch: options.width <= 480, hover: options.width > 480 },
  });
  const html = compiledHtml
    .replace(
      '<html>',
      `<html data-theme="${theme}" dir="${direction}" style="font-size:${fontScale * 100}%">`,
    )
    .replace('<body>', `<body><script>globalThis.__noodleLayout=${layout};</script>`);
  await page.locator('iframe').evaluate((node, content) => {
    (node as HTMLIFrameElement).srcdoc = content;
  }, html);
  await expect.poll(() => page.frames().length).toBe(2);
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error('sandboxed fixture frame did not load');
  await frame.waitForSelector('[data-testid="fixture"]');
  return { context, page, frame };
}
