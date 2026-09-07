import { server, tool, z } from '@noodleseed/one';

const output = z.object({
  status: z.string(),
  summary: z.string(),
});

export default server(
  'form_controls_widget',
  { title: 'Form Controls Widget', version: '1.0.0' },
  [
    tool('open_form_controls', {
      description: 'Open a generated widget with grouped choice, quantity, and confirmation controls.',
      input: z.object({ customer: z.string().default('Guest') }),
      output,
      fulfil: ({ input }) => ({
        status: 'ready',
        summary: `Customize an order for ${input.customer}.`,
      }),
      viewTitle: 'Form controls',
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
  ],
);
