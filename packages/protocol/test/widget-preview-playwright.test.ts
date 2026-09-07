import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe('widget preview adapter in a real browser', () => {
  it('uses a marked private preview adapter when the ExtApps bundle is also present', async () => {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div data-surface></div></body></html>');
    const previewResult = {
      content: [{ type: 'text', text: 'Order unavailable' }],
      structuredContent: {},
      _meta: { retryable: true },
      isError: true,
    };
    await page.evaluate((toolResult) => {
      class ExtApp {
        ontoolresult?: (result: unknown) => void;

        connect(): Promise<void> {
          this.ontoolresult?.({ structuredContent: { wrongAdapter: true } });
          return Promise.resolve();
        }

        getHostCapabilities(): unknown {
          return {};
        }

        getHostContext(): unknown {
          return {};
        }

        getHostVersion(): unknown {
          return {};
        }

        getWidgetState(): unknown {
          return undefined;
        }
      }

      Object.assign(globalThis, {
        ExtApps: { App: ExtApp },
        openai: {
          __noodleDevtools: true,
          __noodleToolResult: toolResult,
          toolInput: {},
          toolOutput: toolResult.structuredContent,
          toolResponseMetadata: toolResult._meta,
          callTool: () => Promise.resolve(toolResult),
        },
      });
    }, previewResult);
    await page.addScriptTag({ content: WIDGET_BOOTSTRAP_SOURCE });

    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __noodleReactBridge?: { getToolResult(): unknown };
            }
          ).__noodleReactBridge?.getToolResult(),
        ),
      )
      .toEqual(previewResult);
    await page.close();
  });
});
