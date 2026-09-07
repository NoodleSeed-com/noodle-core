import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '@noodle-borg/service';
import { createAssistantSessionHandler } from '@noodleseed/assistant/server';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let browser: Browser;
const servers: Server[] = [];

beforeAll(async () => {
  // Keep Chromium's CORS enforcement while allowing the intercepted public app origin to reach the
  // loopback service used by this test; production has two public HTTPS origins and no local-network hop.
  browser = await chromium.launch({
    headless: true,
    args: [
      '--allow-running-insecure-content',
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC',
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('embedded assistant in a real browser', () => {
  it('renders a widget-backed read and confirms a write without exposing credentials', async () => {
    let credentials: { id: string; secret: string; service: string } | undefined;
    const appOrigin = 'https://app.example.com';

    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'browser', env: 'prod' };
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'MODEL_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'MODEL',
      value: 'test',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MODEL_KEY',
      value: 'provider-secret',
    });
    const deployed = await registry.deploy(
      { org: 'acme', app: 'browser', env: 'prod' },
      manifest(appOrigin),
      { accessMode: 'public' },
    );
    expect(deployed.ok, JSON.stringify(deployed)).toBe(true);
    let modelCall = 0;
    const modelFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      modelCall += 1;
      if (modelCall === 1) return Response.json(toolCall('lookup', '{}', 'read_1'));
      if (modelCall === 2) {
        return sseModel(['Account **ready** ', '[unsafe](javascript:alert(1))']);
      }
      if (modelCall === 3) return suggestionResponse();
      if (modelCall === 4) {
        return Response.json(
          toolCall(
            'update_account',
            JSON.stringify({
              name: 'New',
              changes: {
                owner: 'Customer implementation lead with an intentionally long business label',
                targetDate: '2026-09-30',
              },
              note: 'This deliberately long review note proves that the decision controls remain reachable while a customer reads wrapped confirmation content in a narrow assistant panel. '.repeat(
                10,
              ),
            }),
            'write_1',
          ),
        );
      }
      if (modelCall === 5) return sseModel(['Account updated to New']);
      if (modelCall === 6) return suggestionResponse();
      if (modelCall === 7) return Response.json(toolCall('lookup', '{}', 'framework_read_1'));
      if (modelCall === 8) return sseModel(['Framework account ready']);
      if (modelCall === 9) return suggestionResponse();
      throw new Error(`Unexpected model call ${modelCall}`);
    });
    const service = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(service);
    await listen(service);
    const serviceOrigin = origin(service);
    const createdResponse = await fetch(
      `${serviceOrigin}/v1/orgs/acme/apps/browser/envs/prod/assistant/clients`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"browser"}',
      },
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    credentials = { id: created.id, secret: created.clientSecret, service: serviceOrigin };

    const page = await browser.newPage({ colorScheme: 'dark' });
    await page.addInitScript(() => {
      let dropped = false;
      globalThis.addEventListener(
        'message',
        (event) => {
          if (
            dropped ||
            (event.data as { method?: unknown } | null)?.method !==
              'ui/notifications/sandbox-proxy-ready'
          ) {
            return;
          }
          dropped = true;
          (
            globalThis as typeof globalThis & { __droppedAssistantSandboxReady?: boolean }
          ).__droppedAssistantSandboxReady = true;
          event.stopImmediatePropagation();
        },
        { capture: true },
      );
    });
    const requestFailures: string[] = [];
    const browserMessages: string[] = [];
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    page.on('requestfailed', (request) =>
      requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
    );
    page.on('console', (message) => browserMessages.push(message.text()));
    await page.route(`${appOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/assistant/session' && credentials) {
        await sessionGate;
        const handler = createAssistantSessionHandler({
          serviceUrl: credentials.service,
          clientId: credentials.id,
          clientSecret: credentials.secret,
          origin: appOrigin,
          authenticate: () => ({ user: { id: 'browser-user' } }),
        });
        const response = await handler(
          new Request(route.request().url(), {
            method: route.request().method(),
            headers: route.request().headers(),
            body: route.request().postData() ?? '{}',
          }),
        );
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          body: await response.text(),
        });
        return;
      }
      if (url.pathname.startsWith('/sdk/')) {
        await route.fulfill({
          contentType: 'text/javascript',
          body: readFileSync(
            new URL(`../../assistant/dist/${url.pathname.slice('/sdk/'.length)}`, import.meta.url),
          ),
        });
        return;
      }
      if (url.pathname === '/framework-host.js') {
        await route.fulfill({
          contentType: 'text/javascript',
          body: `
import { createAssistantClient } from '/sdk/client.js';
import '/sdk/app-view.js';

const assistant = createAssistantClient({ sessionEndpoint: '/api/assistant/session' });
const viewHost = document.querySelector('#framework-view');
viewHost.client = assistant;
viewHost.theme = 'light';
let firstFrame;
let frameChanges = 0;

assistant.subscribeChat((state) => {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== 'data-view') continue;
      viewHost.view = part.data;
      const currentFrame = viewHost.shadowRoot?.querySelector('.noodle-app-frame');
      if (!firstFrame) firstFrame = currentFrame;
      else if (currentFrame !== firstFrame) frameChanges += 1;
    }
  }
});

globalThis.__frameworkAssistant = {
  sendMessage: (message) => assistant.sendMessage(message),
  setTheme: (theme) => { viewHost.theme = theme; },
  frameChanges: () => frameChanges,
  removeView: () => viewHost.remove(),
};
`,
        });
        return;
      }
      // Strict CSP host page: no 'unsafe-inline' script-src, like a hardened customer SaaS app.
      // Widgets must still truly render — `about:srcdoc` frames inherit this CSP and cannot run
      // their inline bridge, so rendering must go through the hosted sandbox document instead.
      await route.fulfill({
        contentType: 'text/html',
        headers: {
          'content-security-policy':
            `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; ` +
            `connect-src 'self' ${serviceOrigin}; frame-src ${serviceOrigin}; img-src data:`,
        },
        body: '<main id="background"><button id="background-action" type="button">Open support</button></main><noodle-assistant open theme="light" session-endpoint="/api/assistant/session"></noodle-assistant><noodle-app-view id="framework-view"></noodle-app-view><script type="module" src="/sdk/index.js"></script><script type="module" src="/framework-host.js"></script>',
      });
    });
    await page.goto(appOrigin);
    await page.waitForSelector('noodle-assistant');
    const unresolvedFirstPaint = await page.locator('noodle-assistant').evaluate((element) => {
      const panel = element.shadowRoot?.querySelector<HTMLElement>('.panel');
      const launcher = element.shadowRoot?.querySelector<HTMLElement>('.launcher');
      const launcherTrigger =
        element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
      return {
        presentationReady: element.hasAttribute('data-presentation-ready'),
        panelDisplay: panel ? getComputedStyle(panel).display : undefined,
        launcherDisplay: launcher ? getComputedStyle(launcher).display : undefined,
        launcherBusy: launcherTrigger?.getAttribute('aria-busy'),
        visibleBrand: panel?.querySelector('header strong')?.textContent,
      };
    });
    expect(unresolvedFirstPaint).toEqual({
      presentationReady: false,
      panelDisplay: 'none',
      launcherDisplay: 'flex',
      launcherBusy: 'true',
      visibleBrand: 'Assistant',
    });
    releaseSession();
    await expect
      .poll(() =>
        page
          .locator('noodle-assistant')
          .evaluate((element) => (element as HTMLElement).dataset.sessionState),
      )
      .toBe('ready');
    expect(
      await page.locator('noodle-assistant').evaluate((element) => {
        const panel = element.shadowRoot?.querySelector<HTMLElement>('.panel');
        return {
          presentationReady: element.hasAttribute('data-presentation-ready'),
          panelDisplay: panel ? getComputedStyle(panel).display : undefined,
          visibleBrand: panel?.querySelector('header strong')?.textContent,
        };
      }),
    ).toEqual({
      presentationReady: true,
      panelDisplay: 'flex',
      visibleBrand: 'Browser Command',
    });
    const shellBeforeTurn = await page.locator('noodle-assistant').evaluate((element) => {
      const root = element.shadowRoot;
      const testElement = element as HTMLElement & {
        __panelBeforeTurn?: Element | null;
        __messagesBeforeTurn?: Element | null;
      };
      testElement.__panelBeforeTurn = root?.querySelector('.panel');
      testElement.__messagesBeforeTurn = root?.querySelector('.messages');
      return {
        badge: root?.querySelector('.header-badge')?.textContent,
        welcome: root?.querySelector('.empty-state')?.textContent,
        headerMark: Boolean(root?.querySelector('.header-mark[data-variant="status"]')),
        launcherIcon: root?.querySelector('.launcher-glyph')?.getAttribute('data-icon'),
        sessionStatus: root?.querySelector('[data-session-status]')?.textContent,
        panelSurface: (element as HTMLElement).dataset.panelSurface,
        panelElevation: (element as HTMLElement).dataset.panelElevation,
        messageUserStyle: (element as HTMLElement).dataset.messageUserStyle,
      };
    });
    expect(shellBeforeTurn.badge).toContain('LIVE');
    expect(shellBeforeTurn.welcome).toContain('Your command layer.');
    expect(shellBeforeTurn.welcome).toContain('Safe reads and confirmed writes.');
    expect(shellBeforeTurn.headerMark).toBe(true);
    expect(shellBeforeTurn.launcherIcon).toBe('chat');
    expect(shellBeforeTurn.sessionStatus).toBe('Browser session online');
    expect(shellBeforeTurn.panelSurface).toBe('solid');
    expect(shellBeforeTurn.panelElevation).toBe('dramatic');
    expect(shellBeforeTurn.messageUserStyle).toBe('accent');
    await page.locator('noodle-assistant').evaluate((element) => {
      const testElement = element as HTMLElement & {
        __viewEvidence?: {
          resourceUri: string;
          htmlLength: number;
          hasWidgetMarker: boolean;
          hasAppsBridge: boolean;
        };
      };
      element.addEventListener(
        'assistant-view-available',
        (event) => {
          const detail = (event as CustomEvent<{ resourceUri: string; html?: string }>).detail;
          const html = detail.html ?? '';
          testElement.__viewEvidence = {
            resourceUri: detail.resourceUri,
            htmlLength: html.length,
            hasWidgetMarker: html.includes('embedded-widget-e2e'),
            hasAppsBridge: html.includes('globalThis.ExtApps'),
          };
        },
        { once: true },
      );
    });
    try {
      const composer = page.locator('noodle-assistant').locator('textarea');
      await composer.fill('Read account');
      await composer.press('Enter');
    } catch (error) {
      throw new Error(
        `${String(error)}; requests: ${requestFailures.join(' | ')}; browser: ${browserMessages.join(' | ')}`,
      );
    }
    await expect
      .poll(() =>
        page.locator('noodle-assistant').evaluate((element) => element.shadowRoot?.textContent),
      )
      .toContain('Account ready');
    const markdownSafety = await page.locator('noodle-assistant').evaluate((element) => {
      const reply = element.shadowRoot?.querySelector('.message.assistant .markdown');
      return {
        bold: reply?.querySelector('strong')?.textContent,
        unsafeHref: reply?.querySelector('a')?.getAttribute('href') ?? null,
      };
    });
    expect(markdownSafety).toEqual({ bold: 'ready', unsafeHref: null });
    const widgetDelivery = await page.locator('noodle-assistant').evaluate((element) => {
      const testElement = element as HTMLElement & {
        __viewEvidence?: {
          resourceUri: string;
          htmlLength: number;
          hasWidgetMarker: boolean;
          hasAppsBridge: boolean;
        };
      };
      const frame = element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
      return {
        event: testElement.__viewEvidence,
        frame: frame
          ? {
              sandbox: frame.getAttribute('sandbox'),
              referrerPolicy: frame.getAttribute('referrerpolicy'),
              src: frame.getAttribute('src'),
              srcdoc: frame.getAttribute('srcdoc') ?? '',
            }
          : undefined,
      };
    });
    expect(widgetDelivery).toEqual({
      event: {
        resourceUri: 'ui://browser/account_card',
        htmlLength: expect.any(Number),
        hasWidgetMarker: true,
        hasAppsBridge: true,
      },
      frame: {
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        src: `${serviceOrigin}/v1/assistant/sandbox`,
        srcdoc: '',
      },
    });
    expect(widgetDelivery.event?.htmlLength).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          const marker = frame.locator('#embedded-widget-e2e');
          if ((await marker.count()) === 0) continue;
          return {
            status: await frame.locator('#embedded-widget-status').textContent(),
            dark: await frame
              .locator('html')
              .evaluate((element) => element.classList.contains('dark')),
          };
        }
        return undefined;
      })
      .toEqual({ status: 'ready', dark: false });
    const inlineSizing = await page.locator('noodle-assistant').evaluate((element) => {
      const root = element.shadowRoot;
      const frame = root?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
      const messages = root?.querySelector<HTMLElement>('.messages');
      return {
        frameHeight: frame?.getBoundingClientRect().height,
        transcriptScrollable: Boolean(messages && messages.scrollHeight > messages.clientHeight),
        transcriptBottomDistance: messages
          ? messages.scrollHeight - messages.scrollTop - messages.clientHeight
          : undefined,
      };
    });
    expect(inlineSizing.frameHeight).toBeGreaterThan(1_500);
    expect(inlineSizing.transcriptScrollable).toBe(true);
    expect(inlineSizing.transcriptBottomDistance).toBeLessThanOrEqual(2);
    let widgetScrollDistance: number | undefined;
    for (const frame of page.frames()) {
      if ((await frame.locator('#embedded-widget-e2e').count()) === 0) continue;
      widgetScrollDistance = await frame.evaluate(
        () => document.documentElement.scrollHeight - globalThis.innerHeight,
      );
      break;
    }
    expect(widgetScrollDistance).toBeLessThanOrEqual(1);
    await page.locator('noodle-assistant').evaluate((element) => {
      const testElement = element as HTMLElement & {
        __widgetFrameBeforeTheme?: HTMLIFrameElement | null;
      };
      testElement.__widgetFrameBeforeTheme =
        element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
      element.setAttribute('theme', 'dark');
    });
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          const marker = frame.locator('#embedded-widget-e2e');
          if ((await marker.count()) === 0) continue;
          return frame.locator('html').evaluate((element) => element.classList.contains('dark'));
        }
        return undefined;
      })
      .toBe(true);
    expect(
      await page.locator('noodle-assistant').evaluate((element) => {
        const testElement = element as HTMLElement & {
          __widgetFrameBeforeTheme?: HTMLIFrameElement | null;
        };
        return (
          element.shadowRoot?.querySelector('.noodle-app-frame') ===
          testElement.__widgetFrameBeforeTheme
        );
      }),
    ).toBe(true);
    for (const frame of page.frames()) {
      const refresh = frame.locator('#embedded-widget-action');
      if ((await refresh.count()) === 0) continue;
      await refresh.click();
      break;
    }
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          const status = frame.locator('#embedded-widget-status');
          if ((await status.count()) > 0) return status.textContent();
        }
        return undefined;
      })
      .toBe('refreshed');
    expect(
      await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __droppedAssistantSandboxReady?: boolean })
            .__droppedAssistantSandboxReady,
      ),
    ).toBe(true);
    const keptConversationShell = await page.locator('noodle-assistant').evaluate((element) => {
      const testElement = element as HTMLElement & {
        __panelBeforeTurn?: Element | null;
        __messagesBeforeTurn?: Element | null;
      };
      return {
        panel: element.shadowRoot?.querySelector('.panel') === testElement.__panelBeforeTurn,
        messages:
          element.shadowRoot?.querySelector('.messages') === testElement.__messagesBeforeTurn,
      };
    });
    expect(keptConversationShell).toEqual({ panel: true, messages: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBounds = await page.locator('noodle-assistant').evaluate((element) => {
      const panel = element.shadowRoot?.querySelector<HTMLElement>('.panel');
      const prompts = [
        ...(element.shadowRoot?.querySelectorAll('.suggested-prompts button') ?? []),
      ];
      return {
        left: panel?.getBoundingClientRect().left,
        right: panel?.getBoundingClientRect().right,
        viewportWidth: document.documentElement.clientWidth,
        promptsFit: prompts.every((prompt) => {
          const rect = prompt.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
        }),
      };
    });
    expect(mobileBounds.left).toBe(0);
    expect(mobileBounds.right).toBe(mobileBounds.viewportWidth);
    expect(mobileBounds.promptsFit).toBe(true);
    await expect
      .poll(() =>
        page.locator('noodle-assistant').evaluate((element) => ({
          ariaModal: element.shadowRoot?.querySelector('.panel')?.getAttribute('aria-modal'),
          backgroundInert: document.querySelector('#background')?.hasAttribute('inert'),
          startSentinel: element.shadowRoot
            ?.querySelector('[data-focus-start]')
            ?.getAttribute('tabindex'),
          endSentinel: element.shadowRoot
            ?.querySelector('[data-focus-end]')
            ?.getAttribute('tabindex'),
        })),
      )
      .toEqual({
        ariaModal: 'true',
        backgroundInert: true,
        startSentinel: '0',
        endSentinel: '0',
      });
    await page.locator('noodle-assistant').locator('button.close').focus();
    await page.keyboard.press('Shift+Tab');
    expect(
      await page
        .locator('noodle-assistant')
        .evaluate((element) => element.shadowRoot?.activeElement?.classList.contains('powered-by')),
    ).toBe(true);
    await page
      .locator('noodle-assistant')
      .getByRole('button', { name: 'Update name', exact: true })
      .click();
    await expect.poll(() => page.locator('noodle-assistant .tool-proposal').count()).toBe(1);
    await page.locator('noodle-assistant').evaluate((element) => {
      const root = element.shadowRoot;
      const messages = root?.querySelector<HTMLElement>('.messages');
      const card = root?.querySelector<HTMLElement>('.tool-proposal');
      if (messages && card) messages.scrollTop = card.offsetTop;
    });
    const narrowConfirmation = await page.locator('noodle-assistant').evaluate((element) => {
      const root = element.shadowRoot;
      const messages = root?.querySelector<HTMLElement>('.messages');
      const card = root?.querySelector<HTMLElement>('.tool-proposal');
      const actions = root?.querySelector<HTMLElement>('.proposal-actions');
      const argumentList = root?.querySelector<HTMLElement>('.proposal-arguments');
      const messageRect = messages?.getBoundingClientRect();
      const actionRect = actions?.getBoundingClientRect();
      return {
        cardFits: Boolean(card && card.scrollWidth <= card.clientWidth),
        oneColumn: argumentList
          ? getComputedStyle(argumentList).gridTemplateColumns.split(' ').length === 1
          : false,
        actionsSticky: actions ? getComputedStyle(actions).position === 'sticky' : false,
        actionsVisible: Boolean(
          messageRect &&
            actionRect &&
            actionRect.top >= messageRect.top &&
            actionRect.bottom <= messageRect.bottom,
        ),
        hasTechnicalDetails: Boolean(root?.querySelector('.proposal-details')),
      };
    });
    expect(narrowConfirmation).toEqual({
      cardFits: true,
      oneColumn: true,
      actionsSticky: true,
      actionsVisible: true,
      hasTechnicalDetails: false,
    });
    await page
      .locator('noodle-assistant')
      .evaluate((element) => (element as HTMLElement & { close(): void; open(): void }).close());
    await page.locator('#background-action').focus();
    await page
      .locator('noodle-assistant')
      .evaluate((element) => (element as HTMLElement & { open(): void }).open());
    await page.locator('noodle-assistant').locator('textarea').focus();
    await page.keyboard.press('Escape');
    expect(
      await page
        .locator('#background-action')
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page
      .locator('noodle-assistant')
      .evaluate((element) => (element as HTMLElement & { open(): void }).open());
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect
      .poll(() =>
        page.locator('noodle-assistant').evaluate((element) => ({
          ariaModal: element.shadowRoot?.querySelector('.panel')?.getAttribute('aria-modal'),
          backgroundInert: document.querySelector('#background')?.hasAttribute('inert'),
        })),
      )
      .toEqual({ ariaModal: null, backgroundInert: false });
    const confirmationQuality = await page.locator('noodle-assistant').evaluate((element) => {
      const root = element.shadowRoot;
      const buttons = [
        ...(root?.querySelectorAll<HTMLButtonElement>('.tool-proposal button') ?? []),
      ];
      return {
        heading: root?.querySelector('.tool-proposal h3')?.textContent,
        actions: buttons.map((button) => button.textContent),
        minimumTarget: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
        exposesJson: root?.querySelector('.tool-proposal')?.textContent?.includes('{') ?? false,
      };
    });
    expect(confirmationQuality).toMatchObject({
      heading: 'Update account',
      actions: ['Confirm', "Don't proceed"],
      exposesJson: false,
    });
    expect(confirmationQuality.minimumTarget).toBeGreaterThanOrEqual(44);
    await page.locator('noodle-assistant').locator('button', { hasText: 'Confirm' }).click();
    await expect
      .poll(() =>
        page.locator('noodle-assistant').evaluate((element) => element.shadowRoot?.textContent),
      )
      .toContain('New');
    expect(modelCall).toBe(6);

    await page.waitForFunction(
      () =>
        typeof (
          globalThis as typeof globalThis & {
            __frameworkAssistant?: { sendMessage?: unknown };
          }
        ).__frameworkAssistant?.sendMessage === 'function',
    );
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __frameworkAssistant: { sendMessage(message: string): Promise<void> };
        }
      ).__frameworkAssistant.sendMessage('Read account'),
    );
    const frameworkDelivery = await page.locator('#framework-view').evaluate((element) => {
      const frame = element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
      return frame
        ? {
            sandbox: frame.getAttribute('sandbox'),
            referrerPolicy: frame.getAttribute('referrerpolicy'),
            src: frame.getAttribute('src'),
            srcdoc: frame.getAttribute('srcdoc') ?? '',
          }
        : undefined;
    });
    expect(frameworkDelivery).toEqual({
      sandbox: 'allow-scripts',
      referrerPolicy: 'no-referrer',
      src: `${serviceOrigin}/v1/assistant/sandbox`,
      srcdoc: '',
    });
    expect(
      await page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __frameworkAssistant: { frameChanges(): number };
          }
        ).__frameworkAssistant.frameChanges(),
      ),
    ).toBe(0);

    let frameworkWidget = page.mainFrame();
    await expect
      .poll(async () => {
        for (const frame of page.frames()) {
          const marker = frame.locator('#embedded-widget-e2e');
          if ((await marker.count()) === 0) continue;
          const status = await frame.locator('#embedded-widget-status').textContent();
          const dark = await frame
            .locator('html')
            .evaluate((element) => element.classList.contains('dark'));
          if (status === 'ready' && !dark) {
            frameworkWidget = frame;
            return true;
          }
        }
        return false;
      })
      .toBe(true);
    await page.locator('#framework-view').evaluate((element) => {
      (
        element as HTMLElement & { __frameBeforeTheme?: HTMLIFrameElement | null }
      ).__frameBeforeTheme =
        element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
    });
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __frameworkAssistant: { setTheme(theme: 'light' | 'dark'): void };
        }
      ).__frameworkAssistant.setTheme('dark'),
    );
    await expect
      .poll(() =>
        frameworkWidget.locator('html').evaluate((element) => element.classList.contains('dark')),
      )
      .toBe(true);
    expect(
      await page.locator('#framework-view').evaluate((element) => {
        const testElement = element as HTMLElement & {
          __frameBeforeTheme?: HTMLIFrameElement | null;
        };
        return (
          element.shadowRoot?.querySelector('.noodle-app-frame') === testElement.__frameBeforeTheme
        );
      }),
    ).toBe(true);
    await frameworkWidget.locator('#embedded-widget-action').click();
    await expect
      .poll(() => frameworkWidget.locator('#embedded-widget-status').textContent())
      .toBe('refreshed');
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __frameworkAssistant: { removeView(): void };
        }
      ).__frameworkAssistant.removeView(),
    );
    await expect.poll(() => frameworkWidget.isDetached()).toBe(true);

    const exposure = await page.evaluate(
      () => `${document.documentElement.innerHTML}${localStorage.length}${sessionStorage.length}`,
    );
    expect(exposure).not.toContain(created.clientSecret);
    expect(exposure).not.toContain('nss_');
    await page.close();
  });
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function toolCall(name: string, args: string, id: string) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
  };
}
function sseModel(deltas: readonly string[]): Response {
  return new Response(
    `${deltas
      .map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
      .join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function suggestionResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            prompts: [
              'Review the account configuration and explain which changes would need my approval before being applied',
              'Update name',
            ],
          }),
        },
      },
    ],
  });
}
function manifest(allowedOrigin: string): string {
  return `manifestVersion: "1"
server:
  name: browser
  version: 1.0.0
  title: Browser Assistant
  branding:
    name: Browser Command
    accent: '#675CFF'
  assistant:
    model: { kind: openai-compatible, baseUrl: "\${env.MODEL_URL}", model: "\${env.MODEL}", apiKey: MODEL_KEY }
    allowedOrigins: [${allowedOrigin}]
    suggestedPrompts: []
    layout: { mode: floating, position: bottom-right, mobileFullscreen: true }
    labels:
      welcomeHeading: Your command layer.
      welcomeMessage: Safe reads and confirmed writes.
      sessionReady: Browser session online
    presentation:
      panel: { surface: solid, elevation: dramatic, border: strong, radius: 20 }
      launcher: { icon: chat, size: lg, status: session, effect: pulse }
      header:
        mark: status
        badge: { text: LIVE, tone: success, indicator: true }
      composer: { leadingIcon: brand-mark, sendIcon: paper-plane, shape: rounded }
      messages: { userStyle: accent, assistantStyle: bubble }
tools:
  - name: lookup
    description: Read the account.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { status: ready } }
  - name: update_account
    description: Update the account.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, confirm: true }
    inputSchema:
      type: object
      properties:
        name: { type: string, title: Customer name }
        changes:
          type: object
          title: Business changes
          properties:
            owner: { type: string, title: Owner }
            targetDate: { type: string, title: Target date, format: date }
        note: { type: string, title: Review note }
      required: [name, changes, note]
    fulfilment: { steps: [], output: { updated: "\${input.name}" } }
  - name: refresh_account
    description: Refresh the account from its App.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    visibility: [app]
    inputSchema: { type: object }
    fulfilment: { steps: [], output: { status: refreshed } }
widgets:
  - name: account_card
    tool: lookup
    title: Account
    html: '<!doctype html><main id="embedded-widget-e2e" style="min-height:1600px">Account <span id="embedded-widget-status" data-bind="result.status">pending</span><button id="embedded-widget-action" data-action="call" data-action-tool="refresh_account">Refresh</button></main>'
`;
}
