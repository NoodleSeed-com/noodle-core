import { server, tool, z } from '@noodleseed/one';

const output = z.object({
  status: z.string(),
  summary: z.string(),
});

export default server('status_states_widget', {
  title: 'Status States Widget',
  version: '1.0.0',
}, [
  tool('open_status_states', {
    description: 'Open a generated widget with explicit loading, stale, retry, progress, and success states.',
    input: z.object({ query: z.string().default('demo') }),
    output,
    fulfil: ({ input }) => ({
      status: 'ready',
      summary: `Status states are available for ${input.query}.`,
    }),
    viewTitle: 'Status states',
    view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
  }),
]);
