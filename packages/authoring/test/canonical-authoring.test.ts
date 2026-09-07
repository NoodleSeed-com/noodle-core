import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  annotations,
  connector,
  handoffSession,
  prompt,
  resource,
  server,
  tool,
  z,
} from '../src/index.js';

describe('canonical TypeScript authoring API', () => {
  const input = z.object({ name: z.string().default('world') });
  const output = z.object({
    message: z.string(),
    name: z.string(),
  });
  it('emits server metadata and a model-visible tool from the canonical shape', async () => {
    const app = server('hello_server', { title: 'Hello Server', version: '1.0.0' }, [
      tool('greet', {
        title: 'Greet someone',
        description: 'Greet a person by name.',
        input: input,
        output: output,
        fulfil: ({ input }) => ({
          message: `Hello, ${input.name}!`,
          name: input.name,
        }),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.server).toEqual({
      name: 'hello_server',
      title: 'Hello Server',
      version: '1.0.0',
    });
    expect(manifest.tools[0]).toMatchObject({
      name: 'greet',
      title: 'Greet someone',
      description: 'Greet a person by name.',
    });
    expect(manifest.tools[0]?._meta).toBeUndefined();
    expect(manifest.tools[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        message: { type: 'string' },
        name: { type: 'string' },
      },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      message: 'Hello, ${input.name}!',
      name: '${input.name}',
    });
  });

  it('builds typed handoff session envelopes for helper tool results', () => {
    expect(
      handoffSession({
        url: 'https://example.com/checkout/session_123',
        purpose: 'checkout',
        provider: 'example',
        expiresAt: '2026-06-21T12:00:00.000Z',
        stateHandle: { handle: 'cart', key: 'active', completion: 'external' },
      }),
    ).toEqual({
      url: 'https://example.com/checkout/session_123',
      purpose: 'checkout',
      provider: 'example',
      expiresAt: '2026-06-21T12:00:00.000Z',
      stateHandle: { handle: 'cart', key: 'active', completion: 'external' },
    });
  });
  it('emits server branding and handoff policy from the options-plus-definitions shape', async () => {
    const app = server(
      'branded_server',
      {
        title: 'Branded Server',
        version: '1.2.3',
        branding: {
          name: 'Branded Server',
          accent: '#1D9E75',
          radius: 'md',
          density: 'comfortable',
        },
        handoff: {
          allowedDomains: ['https://example.com'],
        },
      },
      [
        tool('greet', {
          description: 'Greet a person by name.',
          input: input,
          output: output,
          fulfil: ({ input }) => ({
            message: `Hello, ${input.name}!`,
            name: input.name,
          }),
        }),
      ],
    );
    const manifest = await app.toManifest();
    expect(manifest.server).toEqual({
      name: 'branded_server',
      title: 'Branded Server',
      version: '1.2.3',
      branding: {
        name: 'Branded Server',
        accent: '#1D9E75',
        radius: 'md',
        density: 'comfortable',
      },
    });
    expect(manifest.handoff).toEqual({ allowedDomains: ['https://example.com'] });
    expect(manifest.tools[0]?.name).toBe('greet');
  });

  it('emits server shell configuration from the options-plus-definitions shape', async () => {
    const app = server(
      'shelled_server',
      {
        title: 'Shelled Server',
        version: '1.0.0',
        shell: {
          displayMode: 'immersive',
          header: { title: 'Trips', subtitle: 'Plan and compare' },
          navigation: {
            variant: 'tabs',
            items: [
              { id: 'discover', label: 'Discover', view: 'discover' },
              { id: 'saved', label: 'Saved', view: 'saved' },
            ],
          },
          persistentActions: [{ id: 'handoff', label: 'Continue', action: 'handoff' }],
        },
      },
      [
        tool('greet', {
          description: 'Greet a person by name.',
          input: input,
          output: output,
          fulfil: ({ input }) => ({
            message: input.name,
          }),
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.shell).toEqual({
      displayMode: 'immersive',
      header: { title: 'Trips', subtitle: 'Plan and compare' },
      navigation: {
        variant: 'tabs',
        items: [
          { id: 'discover', label: 'Discover', view: 'discover' },
          { id: 'saved', label: 'Saved', view: 'saved' },
        ],
      },
      persistentActions: [{ id: 'handoff', label: 'Continue', action: 'handoff' }],
    });
  });
  it('binds connectors from server options instead of chained registration', async () => {
    const api = connector('echo')
      .version('1.0.0')
      .compute('echo', {
        type: 'read',
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        run: (input) => ({ value: String(input.value) }),
      });
    const app = server(
      'connector_server',
      { title: 'Connector Server', version: '1.0.0', use: { api } },
      [
        tool('echo', {
          description: 'Echo a value through a connector.',
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          fulfil: ({ input, connectors }) => {
            const result = connectors.api.echo({ value: input.value });
            return { value: result.value };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.connectors).toEqual({ api: { id: 'echo', version: '1.0.0' } });
    expect(app.toConnectorCatalog()?.connectors).toHaveLength(1);
  });
  it('emits resources and prompts from the canonical definitions array', async () => {
    const app = server('docs_server', { title: 'Docs Server', version: '1.0.0' }, [
      resource('guide', {
        uri: 'docs://guide',
        title: 'Guide',
        mimeType: 'text/markdown',
        fulfil: () => '# Guide',
      }),
      prompt('brief', {
        description: 'Draft a brief.',
        arguments: z.object({
          topic: z.string().describe('Briefing topic.'),
        }),
        fulfil: ({ input }) => `Write about ${input.topic}.`,
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.resources?.[0]).toMatchObject({
      name: 'guide',
      uri: 'docs://guide',
      title: 'Guide',
      mimeType: 'text/markdown',
    });
    expect(manifest.prompts?.[0]).toMatchObject({
      name: 'brief',
      description: 'Draft a brief.',
      arguments: [{ name: 'topic', description: 'Briefing topic.', required: true }],
    });
  });
  it('uses tool visibility for an app-only helper without a second tool factory', async () => {
    const app = server('widget_server', { title: 'Widget Server', version: '1.0.0' }, [
      tool('refresh_greeting', {
        description: 'Refresh the greeting from the widget.',
        input: input,
        output: output,
        visibility: ['app'],
        fulfil: ({ input }) => ({
          message: `Fresh hello, ${input.name}!`,
          name: input.name,
        }),
        annotations: annotations.readOnly(),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.tools[0]).toMatchObject({
      name: 'refresh_greeting',
      visibility: ['app'],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
  });
  it('uses one tool factory for model-visible and view-linked tools', async () => {
    const app = server('widget_server', { title: 'Widget Server', version: '1.0.0' }, [
      tool('refresh_greeting', {
        description: 'Refresh the greeting from the widget.',
        input: input,
        output: output,
        visibility: ['app'],
        fulfil: ({ input }) => ({
          message: `Fresh hello, ${input.name}!`,
          name: input.name,
        }),
      }),
      tool('greet', {
        description: 'Return a greeting and render it in an MCP Apps widget.',
        input: input,
        output: output,
        fulfil: ({ input }) => ({
          message: `Hello, ${input.name}!`,
          name: input.name,
        }),
        viewTitle: 'Greeting card',
        viewDescription: 'A host-rendered greeting card.',
        view: {
          component: 'GreetingCard',
          entry: './views/GreetingCard.tsx',
        },
        annotations: annotations.readOnly({ openWorld: false }),
        csp: { resourceDomains: ['https://example.com'] },
        permissions: { clipboardWrite: {} },
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.tools.find((t) => t.name === 'greet')?.visibility).toBeUndefined();
    expect(manifest.widgets).toEqual([
      {
        name: 'greet_widget',
        tool: 'greet',
        title: 'Greeting card',
        description: 'A host-rendered greeting card.',
        csp: { resourceDomains: ['https://example.com'] },
        permissions: { clipboardWrite: {} },
        view: { component: 'GreetingCard', entry: './views/GreetingCard.tsx' },
      },
    ]);
    const compiled = compileManifest(manifest);
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true);
    if (!compiled.ok) return;
    const widget = compiled.artifact.resources?.find(
      (r) => r.uri === 'ui://widget_server/greet_widget',
    );
    expect(widget?.mimeType).toBe('text/html;profile=mcp-app');
    const html =
      (widget?.fulfilment as { output?: { value?: { value?: string } } }).output?.value?.value ??
      '';
    expect(html).toContain('data-noodle-react-view="GreetingCard"');
    const greet = compiled.artifact.tools.find((t) => t.name === 'greet');
    expect(greet?._meta?.ui?.resourceUri).toBe('ui://widget_server/greet_widget');
  });
});
