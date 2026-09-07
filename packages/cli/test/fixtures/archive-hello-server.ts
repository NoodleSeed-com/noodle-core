import { server, tool, z } from '@noodleseed/one';

// Minimal hello server for the archive/restore CLI tests (fixture copy — tests never use examples/).
export default server('hello', { title: 'Hello', version: '1.0.0' }, [
  tool('greet', {
    description: 'Greet someone by name.',
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    fulfil: ({ input }) => ({ message: `Hello, ${input.name}!` }),
  }),
]);
