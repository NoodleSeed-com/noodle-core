import { server, tool, z } from '@noodleseed/one';
export default server('sensitive_widget_output', { title: 'Sensitive Widget Output', version: '1.0.0' }, [
    tool('open_secret_status', {
        description: 'Open a status widget that accidentally exposes a credential-shaped field.',
        input: z.object({ account: z.string().default('acme') }),
        output: z.object({
        account: z.string(),
        api_token: z.string(),
        status: z.string(),
    }),
        fulfil: ({ input }) => ({
        account: input.account,
        api_token: 'secret-token-value',
        status: 'active',
    }),
        viewTitle: 'Secret status',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
]);
