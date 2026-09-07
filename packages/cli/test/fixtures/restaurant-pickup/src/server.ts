import {
  asset,
  resource,
  server,
  tool,
  z,
} from '@noodleseed/one';

const menu = [
  {
    id: 'falafel_wrap',
    name: 'Falafel Wrap',
    price: 12,
    description: 'Crisp falafel, herbs, pickles, and fries.',
    imageAlt: 'Falafel wrap with fries',
  },
  {
    id: 'lentil_soup',
    name: 'Lentil Soup',
    price: 7,
    description: 'Warm lentils with herbs and flatbread.',
    imageAlt: 'Lentil soup with herbs',
  },
  {
    id: 'mint_lemonade',
    name: 'Mint Lemonade',
    price: 5,
    description: 'Fresh lemon, mint, and sparkling water.',
    imageAlt: 'Mint lemonade with lemon',
  },
] as const;
const falafelImage = asset('assets/falafel-wrap.jpg');
const menuScreenshot = asset('assets/menu-anthropic.png');
const cartScreenshot = asset('assets/cart-anthropic.png');
const checkoutScreenshot = asset('assets/checkout-anthropic.png');
const customerInput = z.object({
  customer: z.string().default('Guest'),
});
const orderInput = z.object({
  customer: z.string().default('Guest'),
  item: z.enum(['falafel_wrap', 'lentil_soup', 'mint_lemonade']).default('falafel_wrap'),
  quantity: z.number().int().min(1).default(1),
});
function menuText(): string {
  return menu.map((item) => `${item.name} ($${item.price})`).join(', ');
}
function menuItems(): { id: string; name: string; price: number; description: string }[] {
  return menu.map(({ id, name, price, description }) => ({ id, name, price, description }));
}
function itemById(id: string): (typeof menu)[number] {
  return menu.find((item) => item.id === id) ?? menu[0];
}
function checkoutUrl(customer: string): string {
  return `https://orders.example.com/pickup?customer=${encodeURIComponent(customer)}`;
}
export default server(
  'restaurant_pickup',
  {
    title: 'Restaurant Pickup',
    version: '1.0.0',
    agentGuide: {
      description: 'Use Restaurant Pickup to browse the menu and prepare a synthetic pickup order.',
      useWhen: [
        'The user wants to browse the synthetic pickup menu.',
        'The user wants to prepare a pickup order.',
      ],
      workflows: [
        {
          id: 'browse_menu',
          title: 'Browse the pickup menu',
          steps: [{ capability: { kind: 'tool', name: 'show_menu' } }],
        },
        {
          id: 'prepare_order',
          title: 'Prepare a pickup order',
          steps: [
            { capability: { kind: 'tool', name: 'show_menu' } },
            { capability: { kind: 'tool', name: 'place_pickup_order' } },
          ],
        },
      ],
      boundaries: [
        'Use only synthetic fixture data.',
        'Keep checkout as an explicit handoff.',
      ],
      examples: [
        { prompt: 'Show me the pickup menu.', workflow: 'browse_menu' },
        { prompt: 'Prepare one falafel wrap for pickup.', workflow: 'prepare_order' },
      ],
    },
    distribution: {
      listing: {
        summary: 'Browse and prepare pickup.',
        description:
          'Restaurant Pickup demonstrates menu discovery, order preparation, an interactive widget, and an explicit checkout handoff.',
        keywords: ['restaurant', 'pickup', 'ordering'],
      },
      publisher: {
        name: 'Noodle Seed Fixtures',
        websiteUrl: 'https://noodleseed.com',
      },
      support: {
        documentationUrl: 'https://docs.noodleseed.com/examples/restaurant-pickup',
        supportUrl: 'https://noodleseed.com/support',
      },
      legal: {
        privacyPolicyUrl: 'https://noodleseed.com/privacy',
        termsOfServiceUrl: 'https://noodleseed.com/terms',
      },
      assets: {
        icon: { source: falafelImage, alt: 'Restaurant Pickup falafel wrap' },
        screenshots: [
          {
            source: menuScreenshot,
            alt: 'Restaurant Pickup MCP App menu',
            prompt: 'Show me the pickup menu.',
          },
          {
            source: cartScreenshot,
            alt: 'Restaurant Pickup MCP App cart',
            prompt: 'Prepare one falafel wrap for pickup.',
          },
          {
            source: checkoutScreenshot,
            alt: 'Restaurant Pickup MCP App checkout handoff',
            prompt: "Review Asha's falafel pickup order before checkout.",
          },
        ],
      },
      review: {
        instructions: 'Use only the synthetic menu. No reviewer credentials are required.',
        scenarios: [
          {
            id: 'browse_menu',
            prompt: 'Show me the pickup menu.',
            expected: 'The synthetic menu is shown without placing an order.',
            shouldInvoke: true,
            tools: ['show_menu'],
          },
          {
            id: 'prepare_falafel',
            prompt: 'Prepare one falafel wrap for pickup.',
            expected: 'A synthetic falafel pickup order is prepared.',
            shouldInvoke: true,
            tools: ['show_menu', 'add_item'],
          },
          {
            id: 'prepare_soup',
            prompt: 'Prepare two lentil soups for pickup.',
            expected: 'A synthetic lentil soup pickup order is prepared.',
            shouldInvoke: true,
            tools: ['show_menu', 'add_item'],
          },
          {
            id: 'inspect_guide',
            prompt: 'Explain how checkout works for this pickup app.',
            expected: 'The guide explains that checkout remains an explicit handoff.',
            shouldInvoke: true,
            tools: ['show_capabilities'],
          },
          {
            id: 'open_widget',
            prompt: 'Open the pickup ordering experience for Asha.',
            expected: 'The ordering widget opens with the synthetic menu.',
            shouldInvoke: true,
            tools: ['show_menu'],
          },
          {
            id: 'unrelated_weather',
            prompt: 'Will it rain tomorrow?',
            expected: 'Restaurant Pickup is not invoked.',
            shouldInvoke: false,
          },
          {
            id: 'real_purchase',
            prompt: 'Charge my card for a real restaurant order.',
            expected: 'The request is refused because the fixture cannot make real purchases.',
            shouldInvoke: false,
          },
          {
            id: 'unsupported_delivery',
            prompt: 'Send a courier to deliver this order.',
            expected: 'The request is not completed because this fixture supports pickup only.',
            shouldInvoke: false,
          },
        ],
      },
    },
    branding: {
      name: 'Restaurant Pickup',
      accent: '#D97706',
      surface: '#FFF7ED',
      surfaceDark: '#1C1712',
      logo: {
        uri: falafelImage,
        alt: 'Restaurant Pickup falafel wrap',
      },
      radius: 'lg',
      density: 'comfortable',
    },
    handoff: {
      allowedDomains: ['https://orders.example.com', 'https://example.com'],
    },
  },
  [
    tool('show_menu', {
      title: 'Show pickup menu',
      description: 'Show the pickup menu and render an ordering widget.',
      input: customerInput,
      output: z.object({
        status: z.string(),
        customer: z.string(),
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            price: z.number(),
            description: z.string(),
          }),
        ),
        total: z.number(),
        checkoutUrl: z.string(),
        note: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Ready for pickup ordering. Menu: ${menuText()}.`,
        customer: input.customer,
        items: menuItems(),
        total: 0,
        checkoutUrl: checkoutUrl(input.customer),
        note: 'Widget actions are available in the capabilities view.',
      }),
      viewTitle: 'Pickup order',
      domain: 'https://pickup.example.com',
      view: {
        component: 'pickup-order',
        entry: './views/pickup-order.tsx',
      },
      viewDescription:
        'A rich pickup-ordering widget covering generated app UI, host actions, assets, media, and handoff.',
      csp: {
        connectDomains: ['https://example.com'],
        resourceDomains: ['https://example.com'],
        frameDomains: ['https://example.com'],
      },
      permissions: { clipboardWrite: {} },
    }),
    tool('place_pickup_order', {
      title: 'Place pickup order',
      description: 'Place a simple pickup order from the menu.',
      input: orderInput,
      output: z.object({
        status: z.string(),
        customer: z.string(),
        itemName: z.string(),
        quantity: z.number(),
        total: z.number(),
        pickupTime: z.string(),
        checkoutUrl: z.string(),
      }),
      fulfil: ({ input }) => {
        const item = itemById(input.item);
        const total = item.price * input.quantity;
        return {
          status: `Order placed for ${input.customer}: ${input.quantity} ${item.name}. Pickup in 15 minutes.`,
          customer: input.customer,
          itemName: item.name,
          quantity: input.quantity,
          total,
          pickupTime: '15 minutes',
          checkoutUrl: checkoutUrl(input.customer),
        };
      },
    }),
    tool('show_capabilities', {
      title: 'Show widget capabilities',
      description: 'Return a concise summary for the standalone widget capability preview.',
      input: z.object({}),
      output: z.object({
        status: z.string(),
        note: z.string(),
      }),
      fulfil: () => ({
        status: 'Restaurant Pickup widget capabilities are ready.',
        note: 'Standalone preview covers widget metadata, CSP, permissions, and downloadable output.',
      }),
      viewName: 'capabilities_card',
      viewTitle: 'Restaurant Pickup capabilities',
      viewDescription:
        'Standalone widget resource for previewing the consolidated widget capability surface.',
      domain: 'https://pickup.example.com',
      view: { component: 'capabilities-card', entry: './views/capabilities-card.tsx' },
      csp: {
        connectDomains: ['https://example.com'],
        resourceDomains: ['https://example.com'],
        frameDomains: ['https://example.com'],
      },
      permissions: { clipboardWrite: {} },
    }),
    tool('add_item', {
      title: 'Add pickup item',
      visibility: ['app'],
      description: 'Add a menu item from the pickup widget.',
      input: orderInput,
      output: z.object({
        status: z.string(),
        customer: z.string(),
        itemName: z.string(),
        quantity: z.number(),
        total: z.number(),
        pickupTime: z.string(),
        checkoutUrl: z.string(),
      }),
      fulfil: ({ input }) => {
        const item = itemById(input.item);
        const total = item.price * input.quantity;
        return {
          status: `Added ${input.quantity} ${item.name} for ${input.customer}.`,
          customer: input.customer,
          itemName: item.name,
          quantity: input.quantity,
          total,
          pickupTime: '15 minutes',
          checkoutUrl: checkoutUrl(input.customer),
        };
      },
    }),
    tool('clear_order', {
      title: 'Clear pickup order',
      visibility: ['app'],
      description: 'Clear the pickup widget order state.',
      input: customerInput,
      output: z.object({
        status: z.string(),
        customer: z.string(),
        total: z.number(),
        checkoutUrl: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Cleared order for ${input.customer}.`,
        customer: input.customer,
        total: 0,
        checkoutUrl: checkoutUrl(input.customer),
      }),
    }),
    tool('refresh_menu_note', {
      title: 'Refresh menu note',
      visibility: ['app'],
      description: 'Refresh a synthetic widget-only note from the pickup capabilities view.',
      input: z.object({
        customer: z.string().default('Guest'),
        note: z.string().default('Widget state note'),
      }),
      output: z.object({
        status: z.string(),
        customer: z.string(),
        note: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Refreshed note for ${input.customer}.`,
        customer: input.customer,
        note: input.note,
      }),
    }),
    resource('restaurant_pickup_guide', {
      uri: 'docs://restaurant-pickup',
      title: 'Restaurant Pickup widget guide',
      description: 'Synthetic guide resource for the consolidated widget flagship.',
      // Return the bare content entry; the runtime maps it into MCP `contents` using the resource's
      // own uri + mimeType. A `{ contents: [...] }` wrapper double-wraps and is rejected at validate.
      fulfil: () => ({
        uri: 'docs://restaurant-pickup',
        mimeType: 'text/markdown',
        text: [
          '# Restaurant Pickup Widget Guide',
          '',
          '- Demonstrates generated widget UI, packaged assets, remote media, handoff, and app-only tools.',
          '- Host actions are mediated by the MCP Apps bridge and never receive private credentials.',
          '- Orders are synthetic; checkout opens an allowlisted example URL.',
        ].join('\n'),
      }),
    }),
  ],
);
