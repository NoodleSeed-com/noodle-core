import { annotations, asset, connector, resource, server, tool, z } from '@noodleseed/one';
import { FOOD_ORDERING_AGENT_GUIDE } from './agent-guide.js';

const heroImage = asset('assets/noodle-bowl.jpg');
const storesScreenshot = asset('assets/food-ordering-stores.png');
const menuScreenshot = asset('assets/food-ordering-menu.png');
const handoffScreenshot = asset('assets/food-ordering-handoff.png');

const state = connector('noodle_state')
  .version('1.0.0')
  .operation('read_state', {
    type: 'read',
    input: z.object({
      handle: z.string(),
      key: z.string().optional(),
    }),
    output: z.object({
      value: z.record(z.string(), z.unknown()),
      revision: z.number().int(),
      status: z.string(),
    }),
  })
  .operation('patch_state', {
    type: 'action',
    input: z.object({
      handle: z.string(),
      expectedRevision: z.number().int(),
      value: z.record(z.string(), z.unknown()),
    }),
    output: z.object({
      value: z.record(z.string(), z.unknown()),
      revision: z.number().int(),
      status: z.string(),
    }),
  });

const stores = [
  {
    id: 'harbor-noodles',
    name: 'Harbor Noodles',
    cuisine: 'Noodles',
    address: '18 Pier Lane',
    open: true,
    etaMinutes: 24,
    rating: 4.8,
  },
  {
    id: 'garden-wraps',
    name: 'Garden Wraps',
    cuisine: 'Vegetarian',
    address: '44 Market Street',
    open: true,
    etaMinutes: 18,
    rating: 4.6,
  },
  {
    id: 'midnight-tacos',
    name: 'Midnight Tacos',
    cuisine: 'Mexican',
    address: '7 Station Road',
    open: false,
    etaMinutes: 35,
    rating: 4.7,
  },
] as const;

const menu = [
  {
    id: 'spicy_miso',
    storeId: 'harbor-noodles',
    category: 'Bowls',
    name: 'Spicy Miso Bowl',
    price: 16,
    description: 'Miso broth, wheat noodles, chili crisp, egg, and greens.',
    modifiers: ['extra_noodles', 'soft_egg', 'chili_crisp'],
  },
  {
    id: 'ginger_tofu',
    storeId: 'harbor-noodles',
    category: 'Bowls',
    name: 'Ginger Tofu Bowl',
    price: 15,
    description: 'Tofu, ginger broth, mushrooms, and scallions.',
    modifiers: ['extra_tofu', 'brown_rice', 'no_mushroom'],
  },
  {
    id: 'green_falafel',
    storeId: 'garden-wraps',
    category: 'Wraps',
    name: 'Green Falafel Wrap',
    price: 13,
    description: 'Falafel, herbs, pickles, tahini, and crisp vegetables.',
    modifiers: ['extra_tahini', 'add_fries', 'gluten_free_wrap'],
  },
  {
    id: 'sweet_potato',
    storeId: 'garden-wraps',
    category: 'Plates',
    name: 'Sweet Potato Plate',
    price: 14,
    description: 'Roasted sweet potato, grains, greens, and lemon yogurt.',
    modifiers: ['vegan_yogurt', 'extra_greens', 'hot_sauce'],
  },
] as const;

const cartLine = z.object({
  itemId: z.string(),
  quantity: z.number().int().min(1),
  modifiers: z.array(z.string()).default([]),
  note: z.string().optional(),
});

const cartInput = z.object({
  selectedStoreId: z.string().optional(),
  lines: z.array(cartLine).default([]),
  customer: z.string().default('Guest'),
  notes: z.string().optional(),
  subtotal: z.number().default(0),
  expectedRevision: z.number().int().min(0).default(0),
});

const storeShape = z.object({
  id: z.string(),
  name: z.string(),
  cuisine: z.string(),
  address: z.string(),
  open: z.boolean(),
  etaMinutes: z.number(),
  rating: z.number(),
});

const menuItemShape = z.object({
  id: z.string(),
  storeId: z.string(),
  category: z.string(),
  name: z.string(),
  price: z.number(),
  description: z.string(),
  // Nested lists count toward the output budget too: unbounded modifiers multiply by every item in a
  // menu payload, so the ceiling is declared here rather than only on the outer array.
  modifiers: z.array(z.string()).max(10),
});

const cartOutput = z.object({
  selectedStoreId: z.string().optional(),
  lines: z.array(cartLine),
  customer: z.string(),
  notes: z.string().optional(),
  subtotal: z.number(),
  status: z.enum(['draft', 'review', 'handoff']),
  checkoutUrl: z.string().optional(),
});

const cartStateSchema = z.object({
  selectedStoreId: z.string().optional(),
  lines: z.array(cartLine),
  customer: z.string(),
  notes: z.string().optional(),
  subtotal: z.number(),
  // `.default()`/`.optional()` state fields are optional on write: a cart save that omits
  // `status` still validates, and a fresh cart starts in `draft`.
  status: z.enum(['draft', 'review', 'handoff']).default('draft'),
  checkoutUrl: z.string().optional(),
});

type CartLine = {
  readonly itemId: string;
  readonly quantity: number;
  readonly modifiers: readonly string[];
  readonly note?: string;
};

type CartInput = {
  readonly selectedStoreId?: string;
  readonly lines: readonly CartLine[];
  readonly customer: string;
  readonly notes?: string;
  readonly subtotal: number;
  readonly expectedRevision: number;
};

const readOnly = annotations.readOnly();
// These writes are app-only controls inside the cart widget. The widget already presents the
// reviewed state and explicit button; `confirm: false` documents direct execution and is equivalent
// to omission because action/open-world hints alone never enable the confirmation gate.
const action = annotations.openAction({ destructive: false, confirm: false });

function checkoutUrl(customer: string): string {
  return `https://orders.example.com/checkout?customer=${encodeURIComponent(customer)}`;
}

function cartValue(input: CartInput, status: 'draft' | 'review' | 'handoff') {
  return {
    selectedStoreId: input.selectedStoreId,
    lines: input.lines,
    customer: input.customer,
    notes: input.notes,
    subtotal: input.subtotal,
    status,
    ...(status === 'handoff' ? { checkoutUrl: 'https://orders.example.com/checkout' } : {}),
  };
}

export default server(
  'food_ordering',
  {
    title: 'Food Ordering',
    version: '1.0.0',
    agentGuide: FOOD_ORDERING_AGENT_GUIDE,
    distribution: {
      listing: {
        summary: 'Build a pickup noodle order.',
        description:
          'Food Ordering is a synthetic MCP App that demonstrates store discovery, menu browsing, a caller-scoped cart, fulfilment planning, and explicit checkout handoff.',
        keywords: ['food', 'ordering', 'delivery'],
      },
      publisher: {
        name: 'Noodle Seed Examples',
        websiteUrl: 'https://noodleseed.com',
      },
      support: {
        documentationUrl: 'https://docs.noodleseed.com/examples/food-ordering',
        supportUrl: 'https://noodleseed.com/support',
      },
      legal: {
        privacyPolicyUrl: 'https://noodleseed.com/privacy',
        termsOfServiceUrl: 'https://noodleseed.com/terms',
      },
      assets: {
        icon: { source: heroImage, alt: 'Food Ordering noodle bowl' },
        screenshots: [
          {
            source: storesScreenshot,
            alt: 'Food Ordering MCP App showing nearby stores',
            prompt: 'Help me build a noodle order for pickup.',
          },
          {
            source: menuScreenshot,
            alt: 'Food Ordering MCP App showing the Harbor Noodles menu',
            prompt: 'Show me the Harbor Noodles menu.',
          },
          {
            source: handoffScreenshot,
            alt: 'Food Ordering MCP App reviewing a checkout handoff',
            prompt: 'Review my spicy miso bowl order before checkout.',
          },
        ],
      },
      review: {
        instructions:
          'Use the synthetic menu and guest cart. No account or reviewer credential is required.',
        scenarios: [
          {
            id: 'build_order',
            prompt: 'Help me build a noodle order for pickup.',
            expected:
              'The ordering app opens with stores and menu items; checkout remains a handoff.',
            shouldInvoke: true,
            tools: ['open_ordering'],
          },
          {
            id: 'browse_menu',
            prompt: 'Show me vegetarian menu options nearby.',
            expected: 'The app shows matching stores and bounded menu choices.',
            shouldInvoke: true,
            tools: ['search_stores', 'load_menu'],
          },
          {
            id: 'compare_options',
            prompt: 'Compare the quickest open food options for me.',
            expected: 'The app grounds its comparison in the synthetic store data.',
            shouldInvoke: true,
            tools: ['search_stores', 'summarize_ordering_options'],
          },
          {
            id: 'plan_pickup',
            prompt: 'Plan a pickup order for Friday.',
            expected: 'The app collects the missing fulfilment details before planning the order.',
            shouldInvoke: true,
            tools: ['plan_order'],
          },
          {
            id: 'review_checkout',
            prompt: 'Review my cart before I continue to checkout.',
            expected: 'The app shows the cart and keeps payment on the explicit external handoff.',
            shouldInvoke: true,
            tools: ['read_cart', 'prepare_checkout'],
          },
          // Negative scenarios are non-invocation cases, so they never declare expected tools.
          {
            id: 'unrelated_weather',
            prompt: 'Will it rain tomorrow?',
            expected: 'Food Ordering is not invoked.',
            shouldInvoke: false,
          },
          {
            id: 'unrelated_email',
            prompt: 'Draft an email to my manager.',
            expected: 'Food Ordering is not invoked.',
            shouldInvoke: false,
          },
          {
            id: 'unrelated_travel',
            prompt: 'Book me a flight to Lisbon.',
            expected: 'Food Ordering is not invoked.',
            shouldInvoke: false,
          },
        ],
      },
    },
    use: { state },
    context: {
      defaults: { locale: 'en-US', timeZone: 'America/New_York' },
      ambient: {
        output: z.object({ serviceArea: z.string(), orderingDate: z.string() }),
        fulfil: ({ context }) => ({
          serviceArea: 'Harbor District',
          orderingDate: context.temporal.localDate,
        }),
      },
    },
    state: {
      handles: {
        cart: {
          kind: 'cart',
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 7200,
          claimOnAuthentication: true,
          schema: cartStateSchema,
        },
      },
    },
    branding: {
      name: 'Food Ordering',
      accent: '#0F8F5F',
      surface: '#F7F7F5',
      surfaceDark: '#111820',
      logo: {
        uri: heroImage,
        alt: 'Food Ordering noodle bowl',
      },
      radius: 'lg',
      density: 'comfortable',
    },
    handoff: {
      allowedDomains: ['https://orders.example.com'],
    },
  },
  [
    tool('open_ordering', {
      title: 'Open food ordering',
      description:
        'Open a complete food-ordering widget with store discovery, menu browsing, cart review, and checkout handoff.',
      annotations: readOnly,
      modelVisibility: {
        latestMessageIncludesAny: [
          'order',
          'food',
          'menu',
          'restaurant',
          'cart',
          'pickup',
          'delivery',
          'checkout',
        ],
        oncePerSession: true,
      },
      input: z.object({
        query: z.string().optional(),
        customer: z.string().default('Guest'),
      }),
      // List outputs declare a ceiling so a host and the model both know the payload is bounded.
      // A recorded `fulfil` cannot slice, so the cap belongs on the shape; connector-backed lists take
      // a pagination input instead. `noodle check` reports `tool_design_output_bounds` without one.
      output: z.object({
        status: z.string(),
        customer: z.string(),
        stores: z.array(storeShape).max(20),
        featuredItems: z.array(menuItemShape).max(20),
        localDate: z.string(),
        serviceArea: z.string(),
        location: z.object({
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        }),
        fallback: z.string(),
      }),
      fulfil: ({ input, context }) => ({
        status: 'Ready to build a food order.',
        customer: input.customer,
        stores,
        featuredItems: menu,
        localDate: context.temporal.localDate,
        serviceArea: context.ambient.serviceArea,
        location: {
          latitude: context.location.latitude.optional(),
          longitude: context.location.longitude.optional(),
        },
        fallback: 'Open stores: Harbor Noodles (Noodles), Garden Wraps (Vegetarian).',
      }),
      viewTitle: 'Food ordering',
      domain: 'https://orders.example.com',
      view: {
        component: 'ordering-flow',
        entry: './views/ordering-flow.tsx',
      },
      viewDescription:
        'A complete consumer ordering surface with app-only helper tools, cart state, and checkout handoff.',
      csp: {
        connectDomains: ['https://orders.example.com'],
        resourceDomains: ['https://orders.example.com'],
        frameDomains: ['https://orders.example.com'],
      },
      permissions: { clipboardWrite: {} },
    }),
    tool('search_stores', {
      title: 'Search stores',
      visibility: ['app'],
      description: 'Filter synthetic restaurants for the ordering widget.',
      annotations: readOnly,
      input: z.object({
        query: z.string().optional(),
        openOnly: z.boolean().default(false),
      }),
      output: z.object({ stores: z.array(storeShape) }),
      fulfil: () => ({ stores }),
    }),
    tool('load_menu', {
      title: 'Load store menu',
      visibility: ['app'],
      description: 'Load synthetic menu categories and items for one store.',
      annotations: readOnly,
      input: z.object({ storeId: z.string() }),
      output: z.object({
        storeId: z.string(),
        stores: z.array(storeShape),
        items: z.array(menuItemShape),
      }),
      fulfil: ({ input }) => ({ storeId: input.storeId, stores, items: menu }),
    }),
    tool('load_item', {
      title: 'Load menu item',
      visibility: ['app'],
      description: 'Load item details and modifier options for the ordering widget.',
      annotations: readOnly,
      input: z.object({ itemId: z.string() }),
      output: z.object({ itemId: z.string(), items: z.array(menuItemShape) }),
      fulfil: ({ input }) => ({ itemId: input.itemId, items: menu }),
    }),
    tool('read_cart', {
      title: 'Read ordering cart',
      visibility: ['app'],
      description: 'Read the caller-scoped ordering cart state.',
      annotations: readOnly,
      input: z.object({}),
      output: z.object({
        value: z.unknown(),
        revision: z.number(),
        status: z.string(),
      }),
      fulfil: ({ connectors }) => {
        const state = connectors.state.readState({ handle: 'cart' });
        return { value: state.value, revision: state.revision, status: state.status };
      },
    }),
    tool('sync_cart', {
      title: 'Update ordering cart',
      visibility: ['app'],
      description: 'Patch the caller-scoped ordering cart with the widget cart mirror.',
      annotations: action,
      input: cartInput,
      output: z.object({
        cart: cartOutput,
        revision: z.number(),
        status: z.string(),
      }),
      fulfil: ({ input, connectors }) => {
        const cart = cartValue(input, 'draft');
        const state = connectors.state.patchState({
          handle: 'cart',
          expectedRevision: input.expectedRevision,
          value: cart,
        });
        return { cart, revision: state.revision, status: state.status };
      },
    }),
    tool('prepare_checkout', {
      title: 'Prepare checkout handoff',
      visibility: ['app'],
      description: 'Prepare the caller-scoped cart for checkout handoff.',
      annotations: action,
      input: cartInput,
      output: z.object({
        cart: cartOutput,
        revision: z.number(),
        checkoutUrl: z.string(),
      }),
      fulfil: ({ input, connectors }) => {
        const cart = cartValue(input, 'handoff');
        const state = connectors.state.patchState({
          handle: 'cart',
          expectedRevision: input.expectedRevision,
          value: cart,
        });
        return {
          cart,
          revision: state.revision,
          checkoutUrl: cart.checkoutUrl ?? checkoutUrl(input.customer),
        };
      },
    }),
    tool('summarize_ordering_options', {
      title: 'Summarize ordering options',
      description: 'Summarize available stores and menu examples without opening the widget.',
      annotations: readOnly,
      input: z.object({}),
      output: z.object({
        stores: z.array(storeShape).max(20),
        featuredItems: z.array(menuItemShape).max(20),
      }),
      fulfil: () => ({ stores, featuredItems: menu }),
    }),
    tool('plan_order', {
      title: 'Plan an order',
      description:
        'Collect a fulfilment method and requested date as structured input, then return a reviewable order plan without placing an order.',
      annotations: readOnly,
      input: z.object({ customer: z.string().default('Guest') }),
      output: z.object({
        customer: z.string(),
        method: z.enum(['pickup', 'delivery']),
        requestedDate: z.string(),
        serviceArea: z.string(),
      }),
      fulfil: ({ input, context, elicit }) => {
        const preference = elicit({
          id: 'choose_fulfilment',
          message: 'How should we fulfil this order?',
          input: z.object({
            method: z.enum(['pickup', 'delivery']).describe('Fulfilment method'),
            requestedDate: z.string().describe('Requested date').meta({ format: 'date' }),
          }),
        });
        return {
          customer: input.customer,
          method: preference.method,
          requestedDate: preference.requestedDate,
          serviceArea: context.ambient.serviceArea,
        };
      },
    }),
    tool('show_capabilities', {
      title: 'Show capabilities',
      description: 'Return a concise summary for the standalone widget capability preview.',
      annotations: readOnly,
      input: z.object({}),
      output: z.object({ status: z.string(), note: z.string() }),
      fulfil: () => ({
        status: 'Food Ordering widget capabilities are ready.',
        note: 'Standalone preview covers React views, helper tools, cart state, handoff, CSP, and permissions.',
      }),
      viewName: 'capabilities_card',
      viewTitle: 'Food Ordering capabilities',
      viewDescription: 'Standalone widget resource for previewing the ordering capability surface.',
      domain: 'https://orders.example.com',
      view: { component: 'capabilities-card', entry: './views/capabilities-card.tsx' },
      csp: {
        connectDomains: ['https://orders.example.com'],
        resourceDomains: ['https://orders.example.com'],
        frameDomains: ['https://orders.example.com'],
      },
      permissions: { clipboardWrite: {} },
    }),
    resource('food_ordering_guide', {
      uri: 'docs://food-ordering',
      title: 'Food Ordering widget guide',
      description: 'Synthetic guide resource for the consumer ordering flagship.',
      mimeType: 'text/markdown',
      // Return the resource body directly; the runtime maps it into MCP `contents` using the
      // resource's own uri + mimeType. Do not return a `{ contents: [...] }` wrapper — that double-wraps.
      fulfil: () =>
        [
          '# Food Ordering Widget Guide',
          '',
          '- Demonstrates a multi-step ordering widget, app-only helper tools, typed cart state, and handoff.',
          '- Store, menu, and checkout data are synthetic and contain no customer credentials.',
          '- Checkout opens an allowlisted example URL; payment and final ordering remain out of scope.',
        ].join('\n'),
    }),
  ],
);
