/**
 * Golden fixture (ADR 0150): the app/widget authoring surface — branding, handoff policy, a durable
 * state handle (with `.default()`/`.optional()` fields), an app-only helper tool, a raw `html`
 * widget, and a React `view` widget. Its emitted manifest is pinned in `widget-suite.manifest.json`.
 */
import { noodlePlatform, server, tool, z } from '../../../src/index.js';

const HTML = '<!doctype html><main data-noodle-widget>Cart</main>';

export default server(
  'acme_shop',
  {
    title: 'Acme Shop',
    version: '2.0.0',
    branding: {
      name: 'Acme Shop',
      accent: '#1D9E75',
      radius: 'md',
      density: 'comfortable',
    },
    handoff: { allowedDomains: ['https://checkout.acme.example'] },
    state: {
      handles: {
        cart: {
          kind: 'cart',
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 7200,
          schema: z.object({
            items: z.array(z.object({ sku: z.string(), quantity: z.number() })),
            note: z.string().optional(),
            status: z.enum(['draft', 'review']).default('draft'),
          }),
        },
      },
    },
    use: { state: noodlePlatform.state.v1 },
  },
  [
    tool('open_cart', {
      description: 'Open the shopping cart.',
      input: z.object({}),
      output: z.object({ status: z.string() }),
      fulfil: () => ({ status: 'ready' }),
      viewName: 'cart_view',
      viewTitle: 'Shopping cart',
      view: { component: 'CartView', entry: './views/CartView.tsx' },
      csp: { connectDomains: ['https://api.acme.example'] },
    }),
    tool('open_receipt', {
      description: 'Show the latest receipt.',
      input: z.object({}),
      output: z.object({ ok: z.string() }),
      fulfil: () => ({ ok: 'yes' }),
      viewName: 'receipt_card',
      viewTitle: 'Receipt',
      view: { html: HTML },
    }),
    tool('load_cart', {
      description: 'Load cart state.',
      input: z.object({}),
      output: z.object({ revision: z.number() }),
      visibility: ['app'],
      fulfil({ connectors }) {
        const state = connectors.state.readState({ handle: 'cart' });
        return { revision: state.revision };
      },
    }),
  ],
);
