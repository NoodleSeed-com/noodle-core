import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

describe('food-ordering example', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
  });

  it('emits a complete ordering app manifest with cart state and app-only helpers', async () => {
    const manifest = (await app.toManifest()) as {
      server: {
        name: string;
        agentGuide?: unknown;
        context?: {
          defaults?: { locale?: string; timeZone?: string };
          ambient?: {
            outputSchema?: unknown;
            fulfilment?: { output?: unknown };
          };
        };
      };
      handoff?: { allowedDomains?: string[] };
      state?: { handles?: Record<string, { kind: string; scope: string }> };
      connectors?: Record<string, { id: string; version: string }>;
      tools: Array<{
        name: string;
        title?: string;
        visibility?: string[];
        annotations?: Record<string, unknown>;
        output?: unknown;
        fulfilment?: { steps?: unknown[]; output?: unknown };
      }>;
      widgets?: Array<{
        name: string;
        tool: string;
        view?: { component?: string; entry?: string };
      }>;
    };

    expect(manifest.server.name).toBe('food_ordering');
    expect(manifest.server.agentGuide).toBeDefined();
    expect(manifest.server).not.toHaveProperty('distribution');
    expect(manifest.server.context).toMatchObject({
      defaults: { locale: 'en-US', timeZone: 'America/New_York' },
      ambient: {
        fulfilment: {
          output: {
            serviceArea: 'Harbor District',
            orderingDate: '${context.temporal.localDate}',
          },
        },
      },
    });
    expect(manifest.state?.handles?.cart).toMatchObject({
      kind: 'cart',
      scope: 'caller',
    });
    expect(manifest.handoff?.allowedDomains).toEqual(['https://orders.example.com']);
    expect(manifest.connectors?.state).toEqual({ id: 'noodle_state', version: '1.0.0' });

    const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    expect(manifest.widgets?.find((widget) => widget.tool === 'open_ordering')?.view).toMatchObject(
      {
        component: 'ordering-flow',
        entry: './views/ordering-flow.tsx',
      },
    );
    for (const helper of [
      'search_stores',
      'load_menu',
      'load_item',
      'read_cart',
      'sync_cart',
      'prepare_checkout',
    ]) {
      expect(tools.get(helper)?.visibility).toEqual(['app']);
    }
    expect(JSON.stringify(tools.get('open_ordering'))).toContain('featuredItems');
    expect(JSON.stringify(tools.get('open_ordering'))).toContain('${context.temporal.localDate}');
    expect(JSON.stringify(tools.get('open_ordering'))).toContain('${context.ambient.serviceArea}');
    expect(JSON.stringify(tools.get('open_ordering'))).toContain('${context.location.latitude}');
    expect(JSON.stringify(tools.get('open_ordering'))).toContain('${context.location.longitude}');
    expect(tools.get('open_ordering')?.annotations).toMatchObject({
      'x-noodleseed-model-latest-message-includes-any': expect.arrayContaining([
        'order',
        'menu',
        'checkout',
      ]),
      'x-noodleseed-model-once-per-session': true,
    });
    expect(JSON.stringify(tools.get('sync_cart'))).toContain('revision');
    expect(tools.get('sync_cart')?.annotations?.confirm).toBe(false);
    expect(tools.get('prepare_checkout')?.annotations?.confirm).toBe(false);
    expect(tools.get('plan_order')?.fulfilment).toMatchObject({
      steps: [
        {
          id: 'choose_fulfilment',
          elicit: {
            message: 'How should we fulfil this order?',
            requestedSchema: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['pickup', 'delivery'] },
                requestedDate: { type: 'string', format: 'date' },
              },
              required: ['method', 'requestedDate'],
            },
          },
        },
      ],
      output: {
        method: '${steps.choose_fulfilment.method}',
        requestedDate: '${steps.choose_fulfilment.requestedDate}',
      },
    });
    expect(manifest.widgets?.map((widget) => widget.name)).toContain('capabilities_card');
    expect(manifest.tools.every((tool) => typeof tool.title === 'string')).toBe(true);
  });

  it('projects host distribution metadata separately from the runtime manifest', () => {
    const distribution = app.toDistributionMetadata();
    expect(distribution).toMatchObject({
      schemaVersion: 1,
      listing: { summary: 'Build a pickup noodle order.' },
      assets: {
        icon: { alt: 'Food Ordering noodle bowl' },
        screenshots: [
          expect.objectContaining({
            alt: 'Food Ordering MCP App showing nearby stores',
            prompt: 'Help me build a noodle order for pickup.',
          }),
          expect.objectContaining({
            alt: 'Food Ordering MCP App showing the Harbor Noodles menu',
            prompt: 'Show me the Harbor Noodles menu.',
          }),
          expect.objectContaining({
            alt: 'Food Ordering MCP App reviewing a checkout handoff',
            prompt: 'Review my spicy miso bowl order before checkout.',
          }),
        ],
      },
    });
    const scenarios = distribution?.review.scenarios ?? [];
    expect(scenarios.filter(({ shouldInvoke }) => shouldInvoke).map(({ id }) => id)).toEqual([
      'build_order',
      'browse_menu',
      'compare_options',
      'plan_pickup',
      'review_checkout',
    ]);
    expect(scenarios.filter(({ shouldInvoke }) => !shouldInvoke).map(({ id }) => id)).toEqual([
      'unrelated_weather',
      'unrelated_email',
      'unrelated_travel',
    ]);
    expect(
      scenarios
        .filter(({ shouldInvoke }) => !shouldInvoke)
        .every((scenario) => !('tools' in scenario)),
    ).toBe(true);
  });
});
