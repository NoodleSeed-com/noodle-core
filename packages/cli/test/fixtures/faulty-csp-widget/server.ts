import { server, tool, z } from '@noodleseed/one';

// A widget whose CSP declares a scheme-less origin the host renderer will silently drop. `noodle check`
// must surface this as an error (fixture for `csp_origin_<widget>`); the deploy route gates on the same
// fault, while `noodle dev`/`validate` only warn so the local author loop still renders the widget.
export default server('faulty_csp_widget', { title: 'Faulty CSP Widget', version: '1.0.0' }, [
  tool('open_cart', {
    description: 'Open the shopping cart.',
    input: z.object({}),
    output: z.object({ ok: z.string() }),
    fulfil: () => ({ ok: 'yes' }),
    viewName: 'cart',
    viewTitle: 'Cart',
    view: { html: '<!doctype html><main>Cart</main>' },
    // Scheme-less — not an absolute https:// origin, so the host drops it.
    csp: { connectDomains: ['api.shop.example.com'] },
  }),
]);
