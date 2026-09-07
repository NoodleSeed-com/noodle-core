import { type Browser, chromium } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILD_READINESS_WIDGET_STYLES } from '../src/plugin-mode/build-readiness-widget.css.js';
import { BuildReadinessWidget } from '../src/plugin-mode/build-readiness-widget.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

function documentHtml(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BUILD_READINESS_WIDGET_STYLES}</style></head><body>${renderToStaticMarkup(createElement(BuildReadinessWidget))}</body></html>`;
}

describe('Build Readiness widget browser layout', () => {
  it('fits the default mobile host widths with full-size, rounded actions', async () => {
    for (const width of [320, 360, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(documentHtml());
      await page.evaluate(() => {
        const action = document.querySelector<HTMLButtonElement>('.action-primary');
        if (action !== null) action.hidden = false;
      });
      const layout = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.readiness-card');
        const action = document.querySelector<HTMLElement>('.action-primary:not([hidden])');
        const heading = document.querySelector<HTMLElement>('h1');
        if (card === null || action === null || heading === null) throw new Error('widget missing');
        return {
          viewportOverflow: document.documentElement.scrollWidth - window.innerWidth,
          cardOverflow: card.scrollWidth - card.clientWidth,
          actionHeight: action.getBoundingClientRect().height,
          actionRadius: Number.parseFloat(getComputedStyle(action).borderRadius),
          headingWeight: Number.parseInt(getComputedStyle(heading).fontWeight, 10),
          visibleActions: [...document.querySelectorAll<HTMLElement>('.action')].filter(
            (candidate) => getComputedStyle(candidate).display !== 'none',
          ).length,
        };
      });
      expect(layout.viewportOverflow, `${width}px viewport`).toBeLessThanOrEqual(0);
      expect(layout.cardOverflow, `${width}px card`).toBeLessThanOrEqual(0);
      expect(layout.actionHeight).toBeGreaterThanOrEqual(44);
      expect(layout.actionRadius).toBeGreaterThanOrEqual(22);
      expect(layout.headingWeight).toBeLessThanOrEqual(600);
      expect(layout.visibleActions).toBe(1);
      await page.close();
    }
  });

  it('adapts its primary contrast and disables decorative motion when requested', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setContent(documentHtml());
    await page.evaluate(() => {
      const action = document.querySelector<HTMLButtonElement>('.action-primary');
      if (action !== null) action.hidden = false;
    });
    const styles = await page.evaluate(() => {
      const action = document.querySelector<HTMLElement>('.action-primary:not([hidden])');
      const shader = document.querySelector<HTMLElement>('.loading-shader');
      if (action === null || shader === null) throw new Error('widget missing');
      return {
        actionBackground: getComputedStyle(action).backgroundColor,
        actionColor: getComputedStyle(action).color,
        shaderDisplay: getComputedStyle(shader).display,
      };
    });
    expect(styles.actionBackground).toBe('rgb(244, 244, 245)');
    expect(styles.actionColor).toBe('rgb(17, 17, 19)');
    expect(styles.shaderDisplay).toBe('none');
  });
});
