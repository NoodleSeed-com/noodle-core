import { type CSSProperties, useMemo, useState } from 'react';
import {
  useBranding,
  useCallTool,
  useLayout,
  useOpenExternal,
  useToolInfo,
  useViewState,
} from '../helpers.js';
import './widget-style.css';

type MenuItem = {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly kind: string;
};

function asMenu(value: unknown) {
  return value as
    | { readonly status?: string; readonly customer?: string; readonly items?: readonly MenuItem[] }
    | undefined;
}

export default function MenuCart() {
  const { displayMode, theme } = useLayout();
  // Widget CSS is ours, so nothing applies `server.branding` for us. Map the one value this widget
  // cares about onto its own custom property; widget-style.css keeps a default for local dev.
  const branding = useBranding();
  const brandStyle = branding.accent
    ? ({ '--nw-accent': branding.accent } as CSSProperties)
    : undefined;
  const openExternal = useOpenExternal();
  const menuResult = asMenu(useToolInfo('show_menu').structuredContent);
  const addToCart = useCallTool('add_to_cart');
  const removeFromCart = useCallTool('remove_from_cart');
  const checkout = useCallTool('create_checkout');

  const items = menuResult?.items ?? [];
  const [customer] = useViewState('customer', menuResult?.customer ?? 'Guest');
  // Cart is session-local (id → quantity); the total is summed here in live React, not in a recorded fulfil.
  const [cart, setCart] = useState<Record<string, number>>({});
  const [status, setStatus] = useState(
    menuResult?.status ?? 'Build your order, then check out to pay.',
  );

  const total = useMemo(
    () => items.reduce((sum, item) => sum + item.price * (cart[item.id] ?? 0), 0),
    [items, cart],
  );
  const lineCount = Object.values(cart).reduce((n, q) => n + q, 0);

  async function add(item: MenuItem) {
    setCart((current) => ({ ...current, [item.id]: (current[item.id] ?? 0) + 1 }));
    const result = await addToCart.callTool({ customer, item: item.id, quantity: 1 });
    const structured = result.structuredContent as { readonly status?: string } | undefined;
    setStatus(structured?.status ?? `Added ${item.name}.`);
  }

  async function remove(item: MenuItem) {
    setCart((current) => {
      const next = { ...current };
      const q = (next[item.id] ?? 0) - 1;
      if (q <= 0) delete next[item.id];
      else next[item.id] = q;
      return next;
    });
    await removeFromCart.callTool({ customer, item: item.id });
  }

  async function payNow() {
    if (lineCount === 0) return;
    // The only handoff: payment. A url-safe cart token + the numeric total go to Acme's PCI checkout.
    const cartToken = items
      .filter((item) => cart[item.id])
      .map((item) => `${item.id}x${cart[item.id]}`)
      .join('-');
    const result = await checkout.callTool({ customer, cartToken, total });
    const structured = result.structuredContent as { readonly checkoutUrl?: string } | undefined;
    if (structured?.checkoutUrl) openExternal(structured.checkoutUrl);
  }

  return (
    <main
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      style={brandStyle}
      data-llm={`Acme Bistro order for ${customer}: ${lineCount} item(s), total $${total}`}
    >
      <section className="nw-card">
        <header className="nw-header">
          <span className="nw-icon" aria-hidden="true">
            <PlateIcon />
          </span>
          <div className="nw-title-block">
            <h1 className="nw-title">Acme Bistro</h1>
            <p className="nw-subtitle">{status}</p>
          </div>
          <span className="nw-chip">
            {displayMode === 'fullscreen' ? 'Fullscreen' : `${lineCount} in cart`}
          </span>
        </header>

        <ul className="nw-menu">
          {items.map((item) => (
            <li className="nw-row" key={item.id}>
              <span className="nw-row-main">
                <span className="nw-name">{item.name}</span>
                <span className="nw-kind">{item.kind}</span>
              </span>
              <span className="nw-price">${item.price}</span>
              <span className="nw-qty">
                <button
                  aria-label={`Remove one ${item.name}`}
                  className="nw-step"
                  type="button"
                  disabled={!cart[item.id]}
                  onClick={() => remove(item)}
                >
                  −
                </button>
                <span className="nw-count">{cart[item.id] ?? 0}</span>
                <button
                  aria-label={`Add one ${item.name}`}
                  className="nw-step"
                  type="button"
                  onClick={() => add(item)}
                >
                  +
                </button>
              </span>
            </li>
          ))}
        </ul>

        <footer className="nw-footer">
          <span className="nw-total">
            Total <strong>${total}</strong>
          </span>
          <button
            className="nw-button nw-button-primary"
            type="button"
            disabled={lineCount === 0 || checkout.isPending}
            onClick={payNow}
          >
            <CardIcon />
            {checkout.isPending ? 'Opening checkout…' : 'Check out & pay'}
          </button>
        </footer>
        <p className="nw-note">
          Payment happens on acme.example — your card is never entered in chat.
        </p>
      </section>
    </main>
  );
}

function PlateIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}
