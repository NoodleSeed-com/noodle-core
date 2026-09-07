import { server, tool, z } from '@noodleseed/one';

export default server(
  'hello',
  {
    title: 'Hello',
    version: '1.0.0',
    branding: {
      name: 'Hello',
      accent: '#1D9E75',
      radius: 'md',
      density: 'comfortable',
    },
  },
  [
    tool('greet', {
      description: 'Greet someone by name.',
      input: z.object({
        name: z.string(),
      }),
      output: z.object({
        message: z.string(),
      }),
      fulfil: ({ input }) => {
        return { message: `Hello, ${input.name}!` };
      },
    }),
  ],
);
