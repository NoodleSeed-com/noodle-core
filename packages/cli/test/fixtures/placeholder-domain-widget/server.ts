import { annotations, server, tool, z } from '@noodleseed/one';

// Mirrors the `noodle init --template widget` scaffold: the widget still carries the placeholder
// domain/CSP host `your-app.example.com`, which `noodle check --target chatgpt` should flag before
// submission (fixture for `chatgpt_widget_placeholder_domain`).
const input = z.object({ name: z.string().default('world') });
const output = z.object({ message: z.string(), name: z.string() });

export default server(
  'placeholder_domain_widget',
  { title: 'Placeholder Domain Widget', version: '1.0.0' },
  [
    tool('greet', {
      description: 'Return a greeting and render it in an MCP Apps widget.',
      annotations: annotations.readOnly(),
      input,
      output,
      fulfil: ({ input }) => ({ message: `Hello, ${input.name}!`, name: input.name }),
      viewTitle: 'Greeting card',
      viewDescription: 'A greeting widget used to exercise placeholder-domain detection.',
      invoking: 'Preparing your greeting…',
      invoked: 'Greeting ready',
      // PLACEHOLDER host, exactly as the scaffold ships it.
      domain: 'https://your-app.example.com',
      csp: {
        connectDomains: ['https://your-app.example.com'],
        resourceDomains: ['https://your-app.example.com'],
        frameDomains: ['https://your-app.example.com'],
      },
      view: {
        component: 'FixtureWidget',
        entry: './views/FixtureWidget.tsx',
      },
    }),
  ],
);
