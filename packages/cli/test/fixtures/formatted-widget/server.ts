import { server, tool, z } from '@noodleseed/one';

const rows = z.array(z.object({ name: z.string(), price: z.number() }));
const output = z.object({
  total: z.number(),
  startsAt: z.string(),
  daysUntil: z.number(),
  distance: z.number(),
  count: z.number(),
  rows,
});

export default server('formatted_widget', { title: 'Formatted Widget', version: '1.0.0' }, [
  tool('open_formatted_widget', {
    description: 'Open a formatted widget.',
    input: z.object({}),
    output,
    fulfil: () => ({
      total: 1234.5,
      startsAt: '2026-06-11T12:00:00.000Z',
      daysUntil: -2,
      distance: 1234.5,
      count: 3,
      rows: 'records',
    }),
    viewTitle: 'Formatted widget',
    view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
  }),
]);
