import { describe, expect, it } from 'vitest';
import type { ArtifactMeta } from '../src/artifact/types.js';
import { compileManifest } from '../src/compile.js';
import type { Manifest } from '../src/manifest/schema.js';
import { testCatalog } from './catalog.js';

const HTML = '<!doctype html><main>Hi</main>';

function manifest(extra: Partial<Manifest>): Manifest {
  return {
    manifestVersion: '1',
    server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
    tools: [
      {
        name: 'open_ticket',
        description: 'Open a ticket.',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { ok: { type: 'string' } } },
        fulfilment: { steps: [{ id: 'm', map: { ok: 'yes' } }], output: { ok: '${steps.m.ok}' } },
      },
    ],
    ...extra,
  } as Manifest;
}

describe('widget compilation', () => {
  it('desugars a React view widget to a ui:// resource and stamps the linked tool', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'ticket_card',
            tool: 'open_ticket',
            title: 'Ticket card',
            description: 'Shows the current ticket.',
            view: { component: 'TicketCard', entry: './views/TicketCard.tsx' },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const widget = result.artifact.resources?.find((resource) => resource.name === 'ticket_card');
    expect(widget?.uri).toBe('ui://acme_support/ticket_card');
    expect(widget?.mimeType).toBe('text/html;profile=mcp-app');
    // The widget `description` is emitted as the ChatGPT compat alias `openai/widgetDescription`.
    expect(widget?._meta).toEqual({
      ui: { prefersBorder: false },
      'openai/widgetDescription': 'Shows the current ticket.',
    });
    const value =
      (widget?.fulfilment as { output?: { value?: { value?: string } } }).output?.value?.value ??
      '';
    expect(value).toContain('id="noodle-react-root"');
    expect(value).toContain('data-noodle-react-view="TicketCard"');
    expect(value).toContain('data-noodle-react-entry="./views/TicketCard.tsx"');

    const tool = result.artifact.tools.find((entry) => entry.name === 'open_ticket');
    expect(tool?._meta).toEqual({
      ui: { resourceUri: 'ui://acme_support/ticket_card' },
      'openai/outputTemplate': 'ui://acme_support/ticket_card',
    });
  });

  it('warns (non-blocking) on a widget CSP origin the host renderer will drop', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'ticket_card',
            tool: 'open_ticket',
            html: HTML,
            csp: { connectDomains: ['api.example.com', 'https://ok.example.com'] },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    // A faulty CSP must NOT fail the compile — the local author loop (dev/validate) still renders it.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csp = result.warnings?.find((w) => w.code === 'widget_csp_unhonorable_origin');
    expect(csp).toBeDefined();
    expect(csp?.path).toBe('widgets.0.csp.connectDomains.0');
    expect(csp?.message).toContain('api.example.com');
    expect(csp?.message).toContain('https://api.example.com');
  });

  it('emits no CSP warning when every origin is an absolute https:// origin', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'ticket_card',
            tool: 'open_ticket',
            html: HTML,
            csp: {
              connectDomains: ['https://ok.example.com'],
              frameDomains: ['https://f.example.com'],
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings?.some((w) => w.code === 'widget_csp_unhonorable_origin')).toBeFalsy();
  });

  it('rejects declarative screen widgets', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'ticket_card',
            tool: 'open_ticket',
            screen: { version: '0.1', root: { type: 'text', text: 'Ticket' } },
          } as unknown as NonNullable<Manifest['widgets']>[number],
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_shape',
          path: 'widgets.0.html',
        }),
      ]),
    );
  });

  it('requires exactly one widget body source: raw html or React view', () => {
    const withBoth = compileManifest(
      manifest({
        widgets: [
          {
            name: 'w',
            tool: 'open_ticket',
            html: HTML,
            view: { component: 'Widget', entry: './views/Widget.tsx' },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(withBoth.ok).toBe(false);

    const withNeither = compileManifest(
      manifest({ widgets: [{ name: 'w', tool: 'open_ticket' } as never] }),
      { catalog: testCatalog },
    );
    expect(withNeither.ok).toBe(false);
  });

  it('injects handoff policy into raw HTML widgets without rewriting author markup', () => {
    const result = compileManifest(
      manifest({
        handoff: { allowedDomains: ['https://app.example.com'] },
        widgets: [
          {
            name: 'raw_card',
            tool: 'open_ticket',
            html: '<!doctype html><html><body><main>Raw</main></body></html>',
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const widget = result.artifact.resources?.find((resource) => resource.name === 'raw_card');
    const value =
      (widget?.fulfilment as { output?: { value?: { value?: string } } }).output?.value?.value ??
      '';
    expect(value).toContain('<body><script type="application/json" data-noodle-policy>');
    expect(value).toContain('<main>Raw</main>');
  });

  it('emits csp and permissions on the widget resource _meta.ui', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'with_meta',
            tool: 'open_ticket',
            view: { component: 'Widget', entry: './views/Widget.tsx' },
            csp: { connectDomains: ['https://api.example.com'] },
            permissions: { clipboardWrite: {} },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const widget = result.artifact.resources?.find((resource) => resource.name === 'with_meta');
    expect(widget?._meta).toEqual({
      'openai/widgetCSP': {
        connect_domains: ['https://api.example.com'],
      },
      ui: {
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
        prefersBorder: false,
      },
    } satisfies ArtifactMeta);
  });

  it('strips the dropped baseUriDomains csp key instead of emitting a dead field', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'with_meta',
            tool: 'open_ticket',
            view: { component: 'Widget', entry: './views/Widget.tsx' },
            csp: {
              connectDomains: ['https://api.example.com'],
              baseUriDomains: ['https://api.example.com'],
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const widget = result.artifact.resources?.find((resource) => resource.name === 'with_meta');
    expect(widget?._meta?.ui).toMatchObject({
      csp: { connectDomains: ['https://api.example.com'] },
    });
    expect(JSON.stringify(widget?._meta)).not.toContain('baseUriDomains');
  });
});

describe('ChatGPT Apps compatibility metadata', () => {
  it('emits frame_domains and handoff-derived redirect_domains on the legacy openai/widgetCSP key', () => {
    const result = compileManifest(
      manifest({
        handoff: { allowedDomains: ['https://orders.example.com'] },
        widgets: [
          {
            name: 'with_frames',
            tool: 'open_ticket',
            view: { component: 'Widget', entry: './views/Widget.tsx' },
            csp: {
              connectDomains: ['https://api.example.com'],
              frameDomains: ['https://maps.example.com'],
            },
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const widget = result.artifact.resources?.find((resource) => resource.name === 'with_frames');
    expect(widget?._meta?.['openai/widgetCSP']).toEqual({
      connect_domains: ['https://api.example.com'],
      frame_domains: ['https://maps.example.com'],
      redirect_domains: ['https://orders.example.com'],
    });
  });

  it('rejects a non-https widget domain', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'bad_domain',
            tool: 'open_ticket',
            view: { component: 'Widget', entry: './views/Widget.tsx' },
            domain: 'http://tickets.example.com',
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.path.includes('domain'))).toBe(true);
  });

  it('emits a widget domain as _meta.ui.domain only', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'with_domain',
            tool: 'open_ticket',
            view: { component: 'Widget', entry: './views/Widget.tsx' },
            domain: 'https://tickets.example.com',
          },
        ],
      }),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const widget = result.artifact.resources?.find((resource) => resource.name === 'with_domain');
    const ui = widget?._meta?.ui as { domain?: string } | undefined;
    expect(ui?.domain).toBe('https://tickets.example.com');
    expect(widget?._meta?.['openai/widgetCSP']).toBeUndefined();
  });
});
