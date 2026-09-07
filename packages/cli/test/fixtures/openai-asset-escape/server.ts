import { asset, server, tool, z } from '@noodleseed/one';

// This file exists and is an image, but it is deliberately outside this server.ts root. The OpenAI export
// boundary must reject it before reading bytes into a target package.
const escapedIcon = asset('../restaurant-pickup/src/assets/falafel-wrap.jpg');

export default server(
  'openai_asset_escape',
  {
    title: 'OpenAI Asset Escape',
    version: '1.0.0',
    agentGuide: {
      description: 'Use this fixture to inspect one synthetic status value.',
      useWhen: ['The user asks for the synthetic status.'],
      workflows: [
        {
          id: 'inspect_status',
          title: 'Inspect status',
          steps: [{ capability: { kind: 'tool', name: 'inspect_status' } }],
        },
      ],
      boundaries: ['Use only the synthetic status.'],
      examples: [{ prompt: 'Show the synthetic status.', workflow: 'inspect_status' }],
    },
    distribution: {
      listing: {
        summary: 'Inspect one synthetic status.',
        description: 'A fixture whose distribution-only image escapes the app root.',
      },
      publisher: { name: 'Noodle Seed Fixtures', websiteUrl: 'https://noodleseed.com' },
      support: {
        documentationUrl: 'https://docs.noodleseed.com',
        supportUrl: 'https://noodleseed.com/support',
      },
      legal: { privacyPolicyUrl: 'https://noodleseed.com/privacy' },
      assets: { icon: { source: escapedIcon, alt: 'Synthetic status icon' } },
      review: {
        instructions: 'Inspect only synthetic data.',
        scenarios: [
          {
            id: 'inspect_status',
            prompt: 'Show the synthetic status.',
            expected: 'The synthetic status is returned.',
            shouldInvoke: true,
          },
        ],
      },
    },
  },
  [
    tool('inspect_status', {
      description: 'Return one synthetic status.',
      input: z.object({}),
      output: z.object({ status: z.string() }),
      fulfil: () => ({ status: 'ready' }),
    }),
  ],
);
