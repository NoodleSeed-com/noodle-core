import { server, tool, z } from '@noodleseed/one';
const pageOutput = z.object({
    title: z.string(),
    copy: z.string(),
    details: z.string(),
});
export default server('website_port_widget', { title: 'Website Port Widget', version: '1.0.0' }, [
    tool('show_marketing_page', {
        description: 'Show a long informational page about a service.',
        input: z.object({ topic: z.string().default('membership') }),
        output: pageOutput,
        fulfil: () => ({
        title: 'Membership program',
        copy: 'Long program copy.',
        details: 'More details.',
    }),
        viewTitle: 'Marketing page',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
]);
