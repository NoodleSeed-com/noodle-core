import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';
import type { Manifest } from '../src/manifest/schema.js';
import {
  MAX_COMPILED_WIDGET_HTML_BYTES,
  MAX_RAW_WIDGET_HTML_BYTES,
  MAX_TOTAL_WIDGET_HTML_BYTES,
} from '../src/widget-limits.js';

function manifest(extra: Partial<Manifest>): Manifest {
  return {
    manifestVersion: '1',
    server: { name: 'react_widget_server', version: '1.0.0', title: 'React Widget Server' },
    tools: [
      {
        name: 'open_widget',
        description: 'Open the widget.',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        fulfilment: {
          steps: [{ id: 'm', map: { message: 'Hello' } }],
          output: { message: '${steps.m.message}' },
        },
      },
    ],
    ...extra,
  } as Manifest;
}

describe('React widget compilation', () => {
  it('accepts a React view widget and emits the standard ui resource link', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'open_widget_view',
            tool: 'open_widget',
            title: 'Open widget',
            view: {
              component: 'open-widget',
              entry: './src/views/open-widget.tsx',
            },
            csp: { resourceDomains: ['https://cdn.example.com'] },
          },
        ],
      }),
    );

    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    const tool = result.artifact.tools.find((item) => item.name === 'open_widget');
    expect(tool?._meta?.ui?.resourceUri).toBe('ui://react_widget_server/open_widget_view');
    expect(tool?._meta?.['openai/outputTemplate']).toBe(
      'ui://react_widget_server/open_widget_view',
    );
    const resource = result.artifact.resources?.find(
      (item) => item.uri === 'ui://react_widget_server/open_widget_view',
    );
    expect(resource?._meta?.ui).toMatchObject({
      csp: { resourceDomains: ['https://cdn.example.com'] },
      prefersBorder: false,
    });
    const html =
      (resource?.fulfilment as { output?: { value?: { value?: string } } }).output?.value?.value ??
      '';
    expect(html).toContain('id="noodle-react-root"');
    expect(html).toContain('data-noodle-react-view="open-widget"');
    expect(html).toContain('data-noodle-react-entry="./src/views/open-widget.tsx"');
  });

  it('rejects widgets with more than one body source', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'bad_widget',
            tool: 'open_widget',
            html: '<!doctype html><main>Bad</main>',
            view: { component: 'bad-widget', entry: './src/views/bad-widget.tsx' },
          },
        ],
      } as Partial<Manifest>),
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

  it('accepts compiled widget HTML through 10 MiB and rejects the next UTF-8 byte', () => {
    const atLimit = compileManifest(
      manifest({
        widgets: [
          {
            name: 'large_widget',
            tool: 'open_widget',
            view: {
              component: 'large-widget',
              entry: './src/views/large-widget.tsx',
              compiledHtml: 'a'.repeat(MAX_COMPILED_WIDGET_HTML_BYTES),
            },
          },
        ],
      }),
    );
    expect(atLimit.ok, atLimit.ok ? '' : JSON.stringify(atLimit.errors)).toBe(true);

    const overLimit = compileManifest(
      manifest({
        widgets: [
          {
            name: 'large_widget',
            tool: 'open_widget',
            view: {
              component: 'large-widget',
              entry: './src/views/large-widget.tsx',
              compiledHtml: `${'a'.repeat(MAX_COMPILED_WIDGET_HTML_BYTES)}b`,
            },
          },
        ],
      }),
    );
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) return;
    expect(overLimit.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'widget_html_too_large',
          path: 'widgets.0.view.compiledHtml',
        }),
      ]),
    );
  });

  it('measures compiled widget HTML in UTF-8 bytes rather than JavaScript code units', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'multibyte_widget',
            tool: 'open_widget',
            view: {
              component: 'multibyte-widget',
              entry: './src/views/multibyte-widget.tsx',
              compiledHtml: 'é'.repeat(MAX_COMPILED_WIDGET_HTML_BYTES / 2 + 1),
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'widget_html_too_large',
          path: 'widgets.0.view.compiledHtml',
        }),
      ]),
    );
  });

  it('caps aggregate stored widget HTML at 20 MiB', () => {
    const thirdBytes = Math.floor(MAX_TOTAL_WIDGET_HTML_BYTES / 3);
    const firstTwo = 'a'.repeat(thirdBytes);
    const remainder = 'a'.repeat(MAX_TOTAL_WIDGET_HTML_BYTES - thirdBytes * 2);
    const base = manifest({
      widgets: [
        {
          name: 'first_widget',
          tool: 'open_widget',
          view: {
            component: 'first-widget',
            entry: './src/views/first-widget.tsx',
            compiledHtml: firstTwo,
          },
        },
        {
          name: 'second_widget',
          tool: 'second_tool',
          view: {
            component: 'second-widget',
            entry: './src/views/second-widget.tsx',
            compiledHtml: firstTwo,
          },
        },
        {
          name: 'third_widget',
          tool: 'third_tool',
          view: {
            component: 'third-widget',
            entry: './src/views/third-widget.tsx',
            compiledHtml: remainder,
          },
        },
      ],
      tools: [
        ...manifest({}).tools,
        {
          ...manifest({}).tools[0],
          name: 'second_tool',
        },
        {
          ...manifest({}).tools[0],
          name: 'third_tool',
        },
      ],
    });
    const atLimit = compileManifest(base);
    expect(atLimit.ok, atLimit.ok ? '' : JSON.stringify(atLimit.errors)).toBe(true);

    const overLimit = compileManifest({
      ...base,
      widgets: base.widgets?.map((widget, index) =>
        index === 2 && widget.view?.compiledHtml !== undefined
          ? {
              ...widget,
              view: { ...widget.view, compiledHtml: `${widget.view.compiledHtml}b` },
            }
          : widget,
      ),
    });
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) return;
    expect(overLimit.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'widget_html_total_too_large',
          path: 'widgets',
        }),
      ]),
    );
  });

  it('keeps raw authored widget HTML capped at 256 KiB', () => {
    const result = compileManifest(
      manifest({
        widgets: [
          {
            name: 'raw_widget',
            tool: 'open_widget',
            html: 'a'.repeat(MAX_RAW_WIDGET_HTML_BYTES + 1),
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'widget_html_too_large',
          path: 'widgets.0.html',
        }),
      ]),
    );
  });
});
