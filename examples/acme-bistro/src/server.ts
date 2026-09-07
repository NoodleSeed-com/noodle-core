import { annotations, managedCollection, server, tool, z } from '@noodleseed/one';

// Acme Bistro is a fictional restaurant. This app is deliberately END-TO-END: the customer browses the
// menu and builds the order in chat, and the order completes in chat — only *payment* hands off, via a
// checkout deep link (the card never touches the app). It is the flagship for the end-to-end pattern.
//
// Authoring notes:
// - A tool `fulfil` is *recorded*, not run as live JS. Inline inputs directly as `${input.x}` into
//   output strings; do not transform them (no arithmetic/encode/filter) or substitution breaks. The
//   cart total is summed in the widget (live React), not in a `fulfil`. The menu below is static data.
// - Tool inputs stay business-facing. `__noodleIntent` is reserved for Noodle's optional serve-time
//   analytics adapter and is removed before `fulfil`, so applications never declare or handle it.

const menu = [
  { id: 'stone_pizza', name: 'Stone-baked Margherita', price: 14, kind: 'Mains' },
  { id: 'roast_bowl', name: 'Harvest Roast Bowl', price: 13, kind: 'Mains' },
  { id: 'house_salad', name: 'House Garden Salad', price: 11, kind: 'Starters' },
  { id: 'lemon_tart', name: 'Lemon Tart', price: 8, kind: 'Desserts' },
  { id: 'sparkling', name: 'Sparkling Water', price: 4, kind: 'Drinks' },
] as const;

const itemId = z.enum(['stone_pizza', 'roast_bowl', 'house_salad', 'lemon_tart', 'sparkling']);

const menuItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  kind: z.string(),
});

const guestRequests = managedCollection('guest_requests', {
  title: 'Guest requests',
  description: 'Guest service requests that restaurant staff can review and resolve.',
  schemaVersion: 1,
  record: z.object({
    locationReference: z.string().min(1).max(120),
    requestType: z.enum(['reservation_help', 'accessibility', 'dietary_question', 'other']),
    summary: z.string().min(1).max(1000),
  }),
});

// Tool annotations for host planners: the menu read is read-only; cart edits are local writes; checkout
// opens an external (payment) link.
const readOnly = annotations.readOnly();
const localWrite = annotations.localAction({ destructive: false, confirm: false });
const openLink = annotations.openAction();

export default server(
  'acme_bistro',
  {
    title: 'Acme Bistro',
    version: '1.0.0',
    branding: {
      name: 'Acme Bistro',
      accent: '#B91C1C',
      surface: '#FEF3F2',
      surfaceDark: '#1A1211',
      radius: 'lg',
      density: 'comfortable',
    },
    // Payment is the only off-app step; the compiler derives ChatGPT redirect_domains from this so the
    // signed checkout link opens without a safe-link warning. The card never reaches this app.
    handoff: {
      allowedDomains: ['https://pay.acme.example', 'https://acme.example'],
    },
    // Reusable business-record intent. Storage, lifecycle, access, and public intake bind separately.
    collections: [guestRequests],
  },
  [
    tool('show_menu', {
      title: 'Show the menu',
      description: 'Show the Acme Bistro menu and render the ordering widget.',
      annotations: readOnly,
      input: z.object({ customer: z.string().default('Guest') }),
      output: z.object({
        status: z.string(),
        customer: z.string(),
        // Bounded list: the menu is a fixed catalog, so the ceiling is declared on the shape rather
        // than taken as a pagination input. `noodle check` reports `tool_design_output_bounds`.
        items: z.array(menuItemOutput).max(50),
      }),
      fulfil: ({ input }) => ({
        status: `Acme Bistro menu is ready for ${input.customer}. Build the order here; pay at checkout.`,
        customer: input.customer,
        items: menu,
      }),
      viewTitle: 'Order at Acme Bistro',
      viewDescription: 'Browse the menu, build an order in chat, and hand off to pay.',
      invoking: 'Loading the menu…',
      invoked: 'Menu ready',
      domain: 'https://order.acme.example',
      view: {
        component: 'menu-cart',
        entry: './views/menu-cart.tsx',
      },
      csp: {
        connectDomains: ['https://acme.example'],
        resourceDomains: ['https://acme.example'],
        frameDomains: ['https://acme.example'],
      },
    }),
    // Widget-only cart edits — the model fills the item from natural language ("add two margheritas").
    tool('add_to_cart', {
      visibility: ['app'],
      description: 'Add a menu item to the Acme Bistro order from the widget.',
      annotations: localWrite,
      input: z.object({
        customer: z.string().default('Guest'),
        item: itemId.default('stone_pizza'),
        quantity: z.number().int().min(1).default(1),
        notes: z.string().default(''),
      }),
      output: z.object({
        status: z.string(),
        item: z.string(),
        quantity: z.number(),
        notes: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Added ${input.quantity} × ${input.item} for ${input.customer}.`,
        item: input.item,
        quantity: input.quantity,
        notes: input.notes,
      }),
    }),
    tool('remove_from_cart', {
      visibility: ['app'],
      description: 'Remove a menu item from the Acme Bistro order.',
      annotations: localWrite,
      input: z.object({
        customer: z.string().default('Guest'),
        item: itemId.default('stone_pizza'),
      }),
      output: z.object({
        status: z.string(),
        item: z.string(),
      }),
      fulfil: ({ input }) => ({
        status: `Removed ${input.item} for ${input.customer}.`,
        item: input.item,
      }),
    }),
    // The only handoff: payment. The widget computes the total (live React) and passes a url-safe cart
    // token + total; the card is entered on Acme's PCI-scoped checkout, never in chat.
    tool('create_checkout', {
      title: 'Create checkout',
      description:
        'Create the Acme Bistro payment checkout link for the current order. Pass a url-safe cart token ' +
        'and the numeric total computed in the widget. Payment happens off-app; the card never reaches this app.',
      annotations: openLink,
      input: z.object({
        customer: z.string().default('Guest'),
        cartToken: z.string().default('cart'),
        total: z.number().min(0).default(0),
      }),
      output: z.object({
        status: z.string(),
        summary: z.string(),
        checkoutUrl: z.string(),
      }),
      // Do not place a literal `$` immediately before a token (`$${input.total}`) — it collides with the
      // `${…}` substitution syntax and leaves the token unresolved. Keep the amount token standalone.
      fulfil: ({ input }) => ({
        status: `Ready to pay for ${input.customer}'s order.`,
        summary: `${input.customer}'s Acme Bistro order · ${input.total} USD`,
        checkoutUrl: `https://pay.acme.example/checkout?cart=${input.cartToken}&total=${input.total}&src=chatgpt`,
      }),
    }),
  ],
);
