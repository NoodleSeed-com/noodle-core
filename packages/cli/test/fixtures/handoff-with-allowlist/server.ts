import { server, tool, z } from '@noodleseed/one';
// Positive fixture: same handoff widget as handoff-no-allowlist, but the server declares
// `handoff.allowedDomains`. `noodle check` must NOT raise `missing_handoff_allowlist` here.
export default server('handoff_with_allowlist', {
    title: 'Handoff With Allowlist',
    version: '1.0.0',
    handoff: {
        allowedDomains: ['https://orders.example.com'],
    },
}, [
    tool('open_checkout', {
        description: 'Open the checkout widget with an external handoff link.',
        input: z.object({ customer: z.string().default('Guest') }),
        output: z.object({ status: z.string(), customer: z.string() }),
        fulfil: ({ input }) => ({ status: `Ready for ${input.customer}.`, customer: input.customer }),
        viewTitle: 'Checkout',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
]);
