import { server, tool, z } from '@noodleseed/one';

const input = z.object({ query: z.string().default('weekend') });
const output = z.object({ query: z.string(), status: z.string() });

export default server(
  'shell_navigation_widget',
  {
    title: 'Shell Navigation Widget',
    version: '1.0.0',
    shell: {
      displayMode: 'comfortable',
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
    tool('open_trips', {
      description: 'Open a trip planning shell with navigation metadata.',
      input,
      output,
      fulfil: ({ input }) => ({ query: input.query, status: 'ready' }),
      viewTitle: 'Trips',
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
  ],
);
