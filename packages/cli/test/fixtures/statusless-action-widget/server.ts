import { server, tool, z } from '@noodleseed/one';

const output = z.object({
  status: z.string(),
});

export default server('statusless_action_widget', {
  title: 'Statusless Action Widget',
  version: '1.0.0',
}, [
  tool('open_statusless_actions', {
    description: 'Open a generated widget that has actions but no explicit status affordance.',
    input: z.object({ query: z.string().default('demo') }),
    output,
    fulfil: () => ({ status: 'ready' }),
    viewTitle: 'Statusless actions',
    view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
  }),
]);
