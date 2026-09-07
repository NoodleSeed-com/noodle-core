import { asset, connector, prompt, resource, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

const compute = connector('packaged_compute')
  .version('1.0.0')
  .compute('double', {
    input: z.object({ value: z.number() }),
    output: z.object({ doubled: z.number() }),
    run: (input) => ({ doubled: Number(input.value) * 2 }),
  });

const records = connector('packaged_records')
  .version('1.0.0')
  .compute('lookup', {
    input: z.object({ id: z.string() }),
    output: z.object({ value: z.string() }),
    run: (input) => ({ value: `record:${String(input.id)}` }),
  });

const lookup = connector('packaged_lookup')
  .version('1.0.0')
  .compute('lookup', {
    input: z.object({ id: z.string() }),
    output: z.object({ value: z.string() }),
    calls: { lookup: 'packaged_records.lookup' },
    run: (input, { callOperation }) => {
      const result = callOperation('lookup', { id: input.id }) as { value: string };
      return { value: result.value };
    },
  });

export default server('previous_published_project', {
  title: 'Previous published project',
  version: '1.0.0',
  use: { compute, records, lookup },
  branding: { logo: { uri: logo, alt: 'Previous project logo' } },
}, [
  tool('greet', {
    description: 'Greet someone by name.',
    input: z.object({ name: z.string() }),
    output: z.object({ message: z.string() }),
    fulfil: ({ input }) => ({ message: `Hello, ${input.name}!` }),
    viewTitle: 'Greeting',
    view: { html: '<!doctype html><main>Greeting</main>' },
  }),
  tool('compute_double', {
    description: 'Double a number in the packaged compute worker.',
    input: z.object({ value: z.number() }),
    output: z.object({ doubled: z.number() }),
    fulfil: ({ input, connectors }) => {
      const result = connectors.compute.double({ value: input.value });
      return { doubled: result.doubled };
    },
  }),
  tool('compute_lookup', {
    description: 'Look up a record through the packaged compute host bridge.',
    input: z.object({ id: z.string() }),
    output: z.object({ value: z.string() }),
    fulfil: ({ input, connectors }) => {
      connectors.records.lookup({ id: input.id });
      const result = connectors.lookup.lookup({ id: input.id });
      return { value: result.value };
    },
  }),
  resource('guide', {
    uri: 'docs://guide',
    title: 'Guide',
    mimeType: 'text/plain',
    fulfil: () => 'Previous published project guide.',
  }),
  prompt('brief', {
    description: 'Create a brief.',
    arguments: z.object({ topic: z.string() }),
    fulfil: ({ input }) => `Brief about ${input.topic}.`,
  }),
]);
