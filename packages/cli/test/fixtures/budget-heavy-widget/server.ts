import { server, tool, z } from '@noodleseed/one';
const rows = z.array(z.object({
    c1: z.string(),
    c2: z.string(),
    c3: z.string(),
    c4: z.string(),
    c5: z.string(),
    c6: z.string(),
    c7: z.string(),
    c8: z.string(),
    c9: z.string(),
}));
export default server('budget_heavy_widget', { title: 'Budget Heavy Widget', version: '1.0.0' }, [
    tool('open_large_admin_view', {
        description: 'Open a dense admin view with many fields and columns.',
        input: z.object({ account: z.string().default('acme') }),
        output: z.object({ rows }),
        fulfil: () => ({ rows: 'records' }),
        viewTitle: 'Large admin view',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
]);
