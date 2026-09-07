import { annotations, handoffSession, server, tool, z } from '@noodleseed/one';

const items = [
  {
    id: 'starter',
    name: 'Starter Pack',
    summary: 'A compact onboarding bundle for first-time customers.',
    price: '$49',
  },
  {
    id: 'growth',
    name: 'Growth Pack',
    summary: 'A higher-touch bundle for teams comparing several options.',
    price: '$149',
  },
] as const;

const openInput = z.object({
  customer: z.string().default('Guest'),
});
const openOutput = z.object({
  status: z.string(),
  customer: z.string(),
  summary: z.string(),
  itemSummary: z.string(),
  selectedItem: z.string(),
  checkoutUrl: z.string(),
});
const itemInput = z.object({
  itemId: z.enum(['starter', 'growth']).default('starter'),
});
const itemOutput = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  price: z.string(),
  recommendation: z.string(),
});
const handoffInput = z.object({
  customer: z.string().default('Guest'),
  itemId: z.enum(['starter', 'growth']).default('starter'),
});
const handoffOutput = z.object({
  status: z.string(),
  customer: z.string(),
  itemName: z.string(),
  checkoutUrl: z.string(),
  url: z.string(),
  purpose: z.string(),
  provider: z.string(),
  expiresAt: z.string(),
  expiresIn: z.string(),
});

function itemById(id: string): (typeof items)[number] {
  return items.find((item) => item.id === id) ?? items[0];
}

function checkoutUrl(customer: string, itemId: string): string {
  const params = new URLSearchParams({ customer, item: itemId });
  return `https://handoff.example.com/checkout?${params.toString()}`;
}

export default server(
  'app_shell_proof',
  {
    title: 'App Shell Proof',
    version: '1.0.0',
    branding: {
      name: 'App Shell Proof',
      accent: '#1D9E75',
      surface: '#F8FFFC',
      surfaceDark: '#111816',
      radius: 'md',
      density: 'comfortable',
    },
    shell: {
      displayMode: 'comfortable',
      header: {
        title: 'App Shell Proof',
        subtitle: 'Browse, review, and hand off safely',
      },
      navigation: {
        variant: 'tabs',
        items: [
          { id: 'overview', label: 'Overview', view: 'overview' },
          { id: 'browse', label: 'Browse', view: 'browse' },
          { id: 'review', label: 'Review', view: 'review' },
        ],
      },
      persistentActions: [{ id: 'handoff', label: 'Continue', action: 'handoff' }],
    },
    handoff: {
      allowedDomains: ['https://handoff.example.com'],
    },
  },
  [
    tool('load_catalog_item', {
      visibility: ['app'],
      description: 'Load catalog item details for the generated app shell review view.',
      input: itemInput,
      output: itemOutput,
      fulfil: ({ input }) => {
        const item = itemById(input.itemId);
        return {
          ...item,
          recommendation:
            item.id === 'starter'
              ? 'Best for first-time evaluation and quick setup.'
              : 'Best for larger teams that need comparison support.',
        };
      },
    }),
    tool('stage_handoff', {
      visibility: ['app'],
      description: 'Create a safe external handoff URL for the selected generated app shell item.',
      input: handoffInput,
      output: handoffOutput,
      fulfil: ({ input }) => {
        const item = itemById(input.itemId);
        return {
          ...handoffSession({
            url: checkoutUrl(input.customer, item.id),
            purpose: 'checkout',
            provider: 'app-shell-proof',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          }),
          status: `Handoff staged for ${input.customer}.`,
          customer: input.customer,
          itemName: item.name,
          checkoutUrl: checkoutUrl(input.customer, item.id),
          expiresIn: '10 minutes',
        };
      },
    }),
    tool('open_consumer_app', {
      description:
        'Open a generated consumer app shell with branded navigation, helper tools, fallback content, and safe handoff.',
      input: openInput,
      output: openOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      fulfil: ({ input }) => ({
        status: `Ready to help ${input.customer} compare two managed bundles.`,
        customer: input.customer,
        summary:
          'This fallback summarizes the generated app for hosts that do not render MCP Apps widgets.',
        itemSummary: items.map((item) => `${item.name} ${item.price}`).join(', '),
        selectedItem: 'starter',
        checkoutUrl: checkoutUrl(input.customer, 'starter'),
      }),
      viewName: 'open_consumer_app_widget',
      viewTitle: 'Consumer app shell',
      viewDescription:
        'Proof fixture for generated app shell composition across branding, navigation, helper tools, fallback, and handoff.',
      csp: {
        connectDomains: [],
        resourceDomains: [],
      },
      view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
    }),
  ],
);
