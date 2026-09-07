import { describe, expect, it } from 'vitest';
import { server, tool, z } from '../src/index.js';
import { generateHelpers } from '../src/react.js';

describe('React widget authoring', () => {
  const input = z.object({ name: z.string().default('world') });
  const output = z.object({ message: z.string(), name: z.string() });

  it('emits a linked widget from a tool view declaration', async () => {
    const app = server('react_widget_server', { title: 'React Widget Server', version: '1.0.0' }, [
      tool('greet', {
        description: 'Return a greeting and render it in a React widget.',
        input,
        output,
        fulfil: ({ input }) => ({
          message: `Hello, ${input.name}!`,
          name: input.name,
        }),
        viewTitle: 'Greeting card',
        viewDescription: 'A React-authored greeting card.',
        view: {
          component: 'greeting-card',
          entry: './src/views/greeting-card.tsx',
        },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.widgets).toEqual([
      {
        name: 'greet_widget',
        tool: 'greet',
        title: 'Greeting card',
        description: 'A React-authored greeting card.',
        view: {
          component: 'greeting-card',
          entry: './src/views/greeting-card.tsx',
        },
      },
    ]);

    expect(manifest.tools.find((item) => item.name === 'greet')).toBeDefined();
  });

  it('emits an explicitly declared React widget', async () => {
    const app = server(
      'explicit_react_widget',
      { title: 'Explicit React Widget', version: '1.0.0' },
      [
        tool('open_card', {
          description: 'Open a React card.',
          input,
          output,
          fulfil: ({ input }) => ({
            message: `Hello, ${input.name}!`,
            name: input.name,
          }),
          viewName: 'card_widget',
          viewTitle: 'Card',
          view: { component: 'card', entry: './src/views/card.tsx' },
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.widgets?.[0]).toMatchObject({
      name: 'card_widget',
      tool: 'open_card',
      view: { component: 'card', entry: './src/views/card.tsx' },
    });
  });

  it('exports typed React helpers for the bridge-backed view surface', () => {
    const helpers = generateHelpers<unknown>();
    expect(Object.keys(helpers).sort()).toEqual([
      'createViewStore',
      'useAppFlow',
      'useBranding',
      'useCallTool',
      'useHandoff',
      'useLayout',
      'useOpenExternal',
      'useRequestDisplayMode',
      'useSendFollowUpMessage',
      'useToolInfo',
      'useUpdateModelContext',
      'useViewState',
      'useWidgetLifecycle',
      'useWidgetReady',
    ]);
    expect(helpers.useToolInfo.toString()).toContain('useBridgeVersion');
    expect(helpers.useCallTool.toString()).toContain('callServerTool');
    expect(helpers.useViewState.toString()).toContain('setWidgetState');
    expect(helpers.useUpdateModelContext.toString()).toContain('updateModelContext');
  });
});
