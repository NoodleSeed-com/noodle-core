import type { AgentGuideSource } from '@noodleseed/one';

/** Product guidance for the model-visible ordering and planning workflows. */
export const FOOD_ORDERING_AGENT_GUIDE = {
  description:
    'Use Food Ordering to browse synthetic local options, build a reviewable cart, and hand checkout to the user.',
  useWhen: [
    'The user wants to browse nearby food or assemble an order.',
    'The user wants a structured pickup or delivery plan before ordering.',
  ],
  workflows: [
    {
      id: 'build_order',
      title: 'Browse and build an order',
      steps: [
        {
          capability: { kind: 'tool', name: 'open_ordering' },
          guidance:
            'Open the ordering app so the user can choose a store, review the cart, and control checkout handoff.',
        },
      ],
    },
    {
      id: 'summarize_options',
      title: 'Summarize available options',
      steps: [{ capability: { kind: 'tool', name: 'summarize_ordering_options' } }],
    },
    {
      id: 'plan_fulfilment',
      title: 'Plan pickup or delivery',
      steps: [
        {
          capability: { kind: 'tool', name: 'plan_order' },
          guidance: 'Collect the user’s fulfilment preference without claiming to place an order.',
        },
      ],
    },
  ],
  boundaries: [
    'Treat every store, menu item, price, and service area in this example as synthetic.',
    'Never claim checkout or payment completed; the final order happens only after the external handoff.',
  ],
  examples: [
    { prompt: 'Help me put together a noodle order.', workflow: 'build_order' },
    { prompt: 'What food options are available?', workflow: 'summarize_options' },
    { prompt: 'Plan a delivery for Friday.', workflow: 'plan_fulfilment' },
  ],
} as const satisfies AgentGuideSource;
