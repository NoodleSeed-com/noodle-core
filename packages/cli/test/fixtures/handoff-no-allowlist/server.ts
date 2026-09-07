import { server, tool, z } from '@noodleseed/one';
// Negative fixture: a widget declares an external handoff action but the server omits
// `handoff.allowedDomains`. This compiles clean (the compiler's link check no-ops without an
// allowlist), yet at runtime every handoff link is refused. `noodle check` must flag it.
export default server('handoff_no_allowlist', {
    title: 'Handoff No Allowlist',
    version: '1.0.0',
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
