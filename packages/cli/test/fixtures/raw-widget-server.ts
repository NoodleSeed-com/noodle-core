
import { server, tool, z } from '@noodleseed/one';

const greetingInput = z.object({
    name: z.string().default('world'),
});
const greetingOutput = z.object({
    message: z.string(),
    name: z.string(),
    refreshed: z.boolean(),
});
export default server('widget_hello', { title: 'Widget Hello', version: '1.0.0' }, [
    tool('greet', {
        description: 'Return a greeting and render it in an MCP Apps widget.',
        input: greetingInput,
        output: greetingOutput,
        fulfil: ({ input }) => ({
        message: `Hello, ${input.name}!`,
        name: input.name,
        refreshed: false,
    }),
        viewTitle: 'Greeting card',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
    tool('refresh_greeting', {
      visibility: ['app'],
        description: 'Refresh the greeting from the widget UI.',
        input: greetingInput,
        output: greetingOutput,
        fulfil: ({ input }) => ({
        message: `Fresh hello, ${input.name || 'world'}!`,
        name: input.name || 'world',
        refreshed: true,
    }),
    }),
]);
