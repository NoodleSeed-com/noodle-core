import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPreview } from '../src/devtools-preview.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('Devtools widget preview scrolling', () => {
  it('keeps a tall widget reachable while its preview controls stay visible', async () => {
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/scroll-test/dev/mcp',
      theme: 'dark',
      device: 'desktop',
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });

    try {
      await page.goto(preview.url);
      await page.evaluate(async () => {
        const frame = document.getElementById('frame');
        const controls = document.getElementById('controls');
        const empty = document.getElementById('empty');
        if (
          !(frame instanceof HTMLIFrameElement) ||
          !(controls instanceof HTMLElement) ||
          !(empty instanceof HTMLElement)
        ) {
          throw new Error('Devtools preview controls are missing');
        }

        empty.style.display = 'none';
        controls.style.display = 'flex';
        frame.style.display = 'block';
        await new Promise<void>((resolve) => {
          frame.addEventListener('load', () => resolve(), { once: true });
          frame.srcdoc = '<!doctype html><main style="height:1600px">Tall widget</main>';
        });
      });
      await page.waitForFunction(() => {
        const frame = document.getElementById('frame');
        return frame instanceof HTMLIFrameElement && frame.getBoundingClientRect().height >= 1600;
      });

      const layout = await page.evaluate(async () => {
        const previewView = document.getElementById('preview-view');
        const controls = document.getElementById('controls');
        const frame = document.getElementById('frame');
        if (
          !(previewView instanceof HTMLElement) ||
          !(controls instanceof HTMLElement) ||
          !(frame instanceof HTMLIFrameElement)
        ) {
          throw new Error('Devtools preview is missing');
        }

        const maxScroll = previewView.scrollHeight - previewView.clientHeight;
        previewView.scrollTop = maxScroll;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const previewRect = previewView.getBoundingClientRect();
        const controlsRect = controls.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        return {
          bodyScrollTop: document.scrollingElement?.scrollTop ?? -1,
          controlsBottom: controlsRect.bottom,
          controlsTop: controlsRect.top,
          frameBottom: frameRect.bottom,
          maxScroll,
          previewBottom: previewRect.bottom,
          previewTop: previewRect.top,
          scrollTop: previewView.scrollTop,
        };
      });

      expect(layout.maxScroll).toBeGreaterThan(0);
      expect(layout.scrollTop).toBe(layout.maxScroll);
      expect(layout.frameBottom).toBeLessThanOrEqual(layout.previewBottom + 1);
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.previewTop);
      expect(layout.controlsBottom).toBeLessThanOrEqual(layout.previewBottom);
      expect(layout.bodyScrollTop).toBe(0);
    } finally {
      await page.close();
      await preview.close();
    }
  });
});
