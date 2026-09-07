import { useMemo, useState } from 'react';
import {
  useCallTool,
  useLayout,
  useOpenExternal,
  useSendFollowUpMessage,
  useToolInfo,
  useViewState,
} from '../helpers.js';
import './widget-style.css';

type MenuItemId = 'falafel_wrap' | 'lentil_soup' | 'mint_lemonade';

type MenuItem = {
  readonly id: MenuItemId;
  readonly name: string;
  readonly price: number;
  readonly description: string;
};

type CartState = {
  readonly status?: string;
  readonly customer?: string;
  readonly itemName?: string;
  readonly quantity?: number;
  readonly total?: number;
  readonly pickupTime?: string;
  readonly checkoutUrl?: string;
};

const menu: readonly MenuItem[] = [
  {
    id: 'falafel_wrap',
    name: 'Falafel Wrap',
    price: 12,
    description: 'Crisp falafel, herbs, pickles, and fries.',
  },
  {
    id: 'lentil_soup',
    name: 'Lentil Soup',
    price: 7,
    description: 'Warm lentils with herbs and flatbread.',
  },
  {
    id: 'mint_lemonade',
    name: 'Mint Lemonade',
    price: 5,
    description: 'Fresh lemon, mint, and sparkling water.',
  },
] as const;

function asMenuResult(value: unknown) {
  return value as
    | {
        readonly status?: string;
        readonly customer?: string;
        readonly items?: readonly MenuItem[];
        readonly total?: number;
        readonly checkoutUrl?: string;
        readonly note?: string;
      }
    | undefined;
}

function asCart(value: unknown): CartState {
  return (value as CartState | undefined) ?? {};
}

export default function PickupOrder() {
  const { displayMode, theme } = useLayout();
  const openExternal = useOpenExternal();
  const sendFollowUpMessage = useSendFollowUpMessage();
  const menuTool = useToolInfo('show_menu');
  const addItem = useCallTool('add_item');
  const clearOrder = useCallTool('clear_order');
  const refreshNote = useCallTool('refresh_menu_note');
  const menuResult = asMenuResult(menuTool.structuredContent);
  const [customer, setCustomer] = useViewState('customer', menuResult?.customer ?? 'Guest');
  const [item, setItem] = useViewState<MenuItemId>('item', 'falafel_wrap');
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useViewState('note', menuResult?.note ?? 'Widget state note');
  const cart = asCart(addItem.data?.structuredContent ?? clearOrder.data?.structuredContent);
  // Render the menu the tool actually returned; the local list is only the pre-data zero state.
  const items = menuResult?.items ?? menu;
  const selected = useMemo(
    () => items.find((entry) => entry.id === item) ?? items[0],
    [items, item],
  );
  const total = cart.total ?? selected.price * quantity;

  return (
    <main
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      data-llm={`Restaurant Pickup order for ${customer}: ${quantity} ${selected.name}, total ${total}`}
    >
      <section className="nw-card">
        <header className="nw-header">
          <span className="nw-icon" aria-hidden="true">
            <UtensilsIcon />
          </span>
          <div className="nw-title-block">
            <h1 className="nw-title">Restaurant Pickup</h1>
            <p className="nw-subtitle">
              {menuResult?.status ?? 'Choose an item and stage a pickup order.'}
            </p>
          </div>
          <span className="nw-chip">{displayMode === 'fullscreen' ? 'Fullscreen' : 'Open'}</span>
        </header>
        <div className="nw-body">
          <div className="nw-grid">
            <div>
              <p className="nw-section-title">Menu</p>
              <div className="nw-menu-list">
                {items.map((entry) => (
                  <button
                    aria-pressed={entry.id === item}
                    className="nw-menu-item"
                    key={entry.id}
                    type="button"
                    onClick={() => setItem(entry.id)}
                  >
                    <span>
                      <span className="nw-menu-name">{entry.name}</span>
                      <span className="nw-menu-desc">{entry.description}</span>
                    </span>
                    <span className="nw-price">${entry.price}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="nw-section-title">Your order</p>
              <dl className="nw-summary">
                <div className="nw-summary-row">
                  <dt>Selected</dt>
                  <dd>{selected.name}</dd>
                </div>
                <div className="nw-summary-row">
                  <dt>Pickup estimate</dt>
                  <dd>{cart.pickupTime ?? '15 minutes'}</dd>
                </div>
                <div className="nw-summary-row">
                  <dt>Status</dt>
                  <dd>{cart.status ?? 'Ready'}</dd>
                </div>
                <div className="nw-summary-row nw-total">
                  <dt>Current total</dt>
                  <dd>${total}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="nw-field-grid">
            <label className="nw-field">
              Customer
              <input
                className="nw-input"
                value={customer}
                onChange={(event) => setCustomer(event.currentTarget.value)}
              />
            </label>
            <label className="nw-field">
              Quantity
              <input
                className="nw-input"
                min={1}
                step={1}
                type="number"
                value={quantity}
                onChange={(event) => setQuantity(Number(event.currentTarget.value) || 1)}
              />
            </label>
          </div>

          <label className="nw-field">
            Item
            <select
              className="nw-select"
              value={item}
              onChange={(event) => setItem(event.currentTarget.value as MenuItemId)}
            >
              {items.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>

          <div className="nw-actions">
            <button
              className="nw-button nw-button-primary"
              type="button"
              disabled={addItem.isPending}
              onClick={async () => {
                await addItem.callTool({ customer, item, quantity });
              }}
            >
              <BagIcon />
              {addItem.isPending ? 'Adding...' : 'Add item'}
            </button>
            <button
              className="nw-button"
              type="button"
              onClick={async () => {
                await clearOrder.callTool({ customer });
              }}
            >
              <RefreshIcon />
              Clear order
            </button>
            <button
              className="nw-button"
              type="button"
              onClick={async () => {
                const result = await refreshNote.callTool({ customer, note });
                const structured = result.structuredContent as
                  | { readonly note?: string }
                  | undefined;
                setNote(structured?.note ?? note);
              }}
            >
              <NoteIcon />
              Refresh note
            </button>
            <button
              className="nw-button"
              type="button"
              onClick={() =>
                sendFollowUpMessage({
                  prompt: 'Help me choose a pickup order from the Restaurant Pickup menu.',
                })
              }
            >
              <SparkIcon />
              Ask assistant
            </button>
            <button
              className="nw-button"
              type="button"
              onClick={() => openExternal(cart.checkoutUrl ?? menuResult?.checkoutUrl ?? '')}
            >
              <ExternalIcon />
              Continue checkout
            </button>
          </div>
          <p className="nw-note">{note}</p>
        </div>
        <footer className="nw-footer">
          <span className="nw-meta">
            <ClockIcon />
            Ready today at 12:30 PM
          </span>
          <span className="nw-meta">
            <PinIcon />
            123 Main St
          </span>
        </footer>
      </section>
    </main>
  );
}

function UtensilsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3v8" />
      <path d="M4 3v5a3 3 0 0 0 6 0V3" />
      <path d="M7 11v10" />
      <path d="M17 3v18" />
      <path d="M14 3h4a2 2 0 0 1 2 2v5a4 4 0 0 1-4 4h-2" />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8h12l-1 12H7L6 8Z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h9l3 3v15H6V3Z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6" />
      <path d="M9 16h4" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s6-5.3 6-11a6 6 0 1 0-12 0c0 5.7 6 11 6 11Z" />
      <circle cx="12" cy="10" r="2" />
    </svg>
  );
}
