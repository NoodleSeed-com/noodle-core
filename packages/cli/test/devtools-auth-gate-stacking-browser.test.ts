import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevtoolsDelegatedExchangeStatus } from '../src/devtools-delegated-exchange-state.js';
import { startPreview } from '../src/devtools-preview.js';

let browser: Browser;
const DELEGATED_BINDING_COUNT = 12;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

function delegatedStatus(): DevtoolsDelegatedExchangeStatus {
  return {
    issuer: 'urn:noodleseed:devtools:stacking-test',
    jwks: {
      keys: [
        {
          kty: 'RSA',
          kid: 'stacking-test',
          use: 'sig',
          alg: 'RS256',
          n: 'public-modulus'.repeat(40),
          e: 'AQAB',
        },
      ],
    },
    trustChanged: false,
    tenant: 'local/stacking-test/dev',
    deployment: 'stacking-test-1234abcd',
    bindings: Array.from({ length: DELEGATED_BINDING_COUNT }, (_, index) => ({
      bindingKey: `sha256:${String(index).padStart(64, '0')}`,
      connectorId: `connector-${index}`,
      operation: 'records.read',
      audience: `api://connector-${index}.example.test/${'audience'.repeat(12)}`,
      verified: false,
    })),
  };
}

describe('Devtools auth gate browser stacking', () => {
  for (const viewport of [
    { name: 'desktop', width: 1600, height: 1050 },
    { name: 'narrow', width: 720, height: 900 },
  ]) {
    it(`keeps the sign-in gate above an expanded setup panel at ${viewport.name} width`, async () => {
      const preview = await startPreview({
        mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
        theme: 'dark',
        device: 'both',
        customerAuth: {
          kind: 'firebase',
          projectId: 'stacking-test',
          apiKey: 'public-web-key',
          authDomain: 'stacking-test.firebaseapp.com',
        },
        localDelegatedExchange: delegatedStatus,
      });
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });

      try {
        await page.goto(preview.url);
        await page.locator('#local-delegated-exchange').evaluate((element) => {
          (element as HTMLDetailsElement).open = true;
        });
        await page.waitForFunction(() => document.body.classList.contains('auth-locked'));

        const visibleContext = await page.evaluate((expectedAudienceCount) => {
          const client = globalThis as typeof globalThis & {
            paintAuthStatus(status: {
              state: string;
              supported: boolean;
              issuer?: string;
              scopes: string[];
            }): void;
          };
          client.paintAuthStatus({
            state: 'signed_in',
            supported: true,
            issuer: 'https://stacking-test.firebaseapp.com',
            scopes: [],
          });

          const delegatedPanel = document.getElementById('local-delegated-exchange');
          const tenant = document.getElementById('local-delegated-exchange-tenant');
          const deployment = document.getElementById('local-delegated-exchange-deployment');
          const audiences = Array.from(
            document.querySelectorAll<HTMLElement>('.local-delegated-exchange__binding-audience'),
          );
          if (delegatedPanel === null || tenant === null || deployment === null) {
            return {
              assertionContextVisible: false,
              hasExpectedAudiences: false,
              everyAudienceVisible: false,
              panelFits: false,
            };
          }
          const panelRect = delegatedPanel.getBoundingClientRect();
          const hasExpectedAudiences = audiences.length === expectedAudienceCount;
          const isInsidePanel = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= panelRect.left &&
              rect.right <= panelRect.right &&
              rect.top >= panelRect.top &&
              rect.bottom <= panelRect.bottom
            );
          };
          return {
            assertionContextVisible: isInsidePanel(tenant) && isInsidePanel(deployment),
            hasExpectedAudiences,
            everyAudienceVisible:
              hasExpectedAudiences &&
              audiences.every(
                (audience) =>
                  isInsidePanel(audience) && getComputedStyle(audience).display !== 'none',
              ),
            panelFits: delegatedPanel.scrollWidth <= delegatedPanel.clientWidth,
          };
        }, DELEGATED_BINDING_COUNT);
        expect(visibleContext.assertionContextVisible, JSON.stringify(visibleContext)).toBe(true);
        expect(visibleContext.hasExpectedAudiences, JSON.stringify(visibleContext)).toBe(true);
        expect(visibleContext.everyAudienceVisible, JSON.stringify(visibleContext)).toBe(true);
        expect(visibleContext.panelFits, JSON.stringify(visibleContext)).toBe(true);

        await page.evaluate(() => {
          const client = globalThis as typeof globalThis & {
            paintAuthStatus(status: { state: string; supported: boolean; scopes: string[] }): void;
          };
          client.paintAuthStatus({ state: 'signed_out', supported: true, scopes: [] });
        });
        await page.waitForFunction(() => document.body.classList.contains('auth-locked'));

        const result = await page.evaluate(() => {
          const authGate = document.getElementById('auth-gate');
          const assertionContext = document.querySelector('.local-delegated-exchange__context');
          const tenant = document.getElementById('local-delegated-exchange-tenant');
          const deployment = document.getElementById('local-delegated-exchange-deployment');
          if (
            authGate === null ||
            assertionContext === null ||
            tenant === null ||
            deployment === null
          ) {
            return {
              hasAssertionTargets: false,
              assertionContextContainsTargets: false,
              authGateOwnsContextPoints: false,
              topElements: [],
            };
          }

          const contextRect = assertionContext.getBoundingClientRect();
          const targetPoints = [tenant, deployment].map((target) => {
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const topElement = document.elementFromPoint(x, y);
            return {
              hasArea: rect.width > 0 && rect.height > 0,
              insideContext:
                x >= contextRect.left &&
                x <= contextRect.right &&
                y >= contextRect.top &&
                y <= contextRect.bottom,
              ownedByAuthGate: topElement !== null && authGate.contains(topElement),
              topElement:
                topElement instanceof HTMLElement
                  ? `${topElement.tagName.toLowerCase()}.${topElement.className}`
                  : null,
            };
          });
          return {
            hasAssertionTargets: targetPoints.length === 2,
            assertionContextContainsTargets: targetPoints.every(
              (target) => target.hasArea && target.insideContext,
            ),
            authGateOwnsContextPoints: targetPoints.every((target) => target.ownedByAuthGate),
            topElements: targetPoints.map((target) => target.topElement),
          };
        });

        expect(result.hasAssertionTargets).toBe(true);
        expect(result.assertionContextContainsTargets, JSON.stringify(result)).toBe(true);
        expect(result.authGateOwnsContextPoints, JSON.stringify(result)).toBe(true);
      } finally {
        await page.close();
        await preview.close();
      }
    });
  }

  it('exits an active fullscreen frame when authentication is lost', async () => {
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'dark',
      device: 'both',
      customerAuth: {
        kind: 'firebase',
        projectId: 'stacking-test',
        apiKey: 'public-web-key',
        authDomain: 'stacking-test.firebaseapp.com',
      },
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

    try {
      await page.goto(preview.url);
      const entered = await page.evaluate(() => {
        const client = globalThis as typeof globalThis & {
          enterFullscreen(frame: HTMLIFrameElement): void;
          paintAuthStatus(status: {
            state: string;
            supported: boolean;
            issuer?: string;
            scopes: string[];
          }): void;
        };
        const frame = document.getElementById('frame') as HTMLIFrameElement;
        client.paintAuthStatus({
          state: 'signed_in',
          supported: true,
          issuer: 'https://stacking-test.firebaseapp.com',
          scopes: [],
        });
        client.enterFullscreen(frame);
        return {
          locked: document.body.classList.contains('auth-locked'),
          fullscreen: frame.classList.contains('nd-frame-full'),
          exitExists: document.getElementById('fs-exit') !== null,
        };
      });
      expect(entered).toEqual({ locked: false, fullscreen: true, exitExists: true });

      const locked = await page.evaluate(() => {
        const client = globalThis as typeof globalThis & {
          paintAuthStatus(status: { state: string; supported: boolean; scopes: string[] }): void;
        };
        const frame = document.getElementById('frame') as HTMLIFrameElement;
        client.paintAuthStatus({ state: 'signed_out', supported: true, scopes: [] });
        return {
          locked: document.body.classList.contains('auth-locked'),
          fullscreen: frame.classList.contains('nd-frame-full'),
          exitExists: document.getElementById('fs-exit') !== null,
        };
      });
      expect(locked).toEqual({ locked: true, fullscreen: false, exitExists: false });
    } finally {
      await page.close();
      await preview.close();
    }
  });

  it('suppresses fullscreen frame and exit controls while authentication is locked', async () => {
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'dark',
      device: 'both',
      customerAuth: {
        kind: 'firebase',
        projectId: 'stacking-test',
        apiKey: 'public-web-key',
        authDomain: 'stacking-test.firebaseapp.com',
      },
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

    try {
      await page.goto(preview.url);
      const visibility = await page.evaluate(() => {
        const frame = document.getElementById('frame') as HTMLIFrameElement;
        frame.classList.add('nd-frame-full');
        const exit = document.createElement('button');
        exit.id = 'fs-exit';
        document.body.appendChild(exit);
        return {
          frameDisplay: getComputedStyle(frame).display,
          exitDisplay: getComputedStyle(exit).display,
        };
      });
      expect(visibility).toEqual({ frameDisplay: 'none', exitDisplay: 'none' });
    } finally {
      await page.close();
      await preview.close();
    }
  });
});
