import { useEffect, useMemo, useState } from 'react';
import {
  ActionBar,
  AppShell,
  AsyncBoundary,
  ChoiceGroup,
  createViewStore,
  DataCard,
  DataList,
  Feedback,
  Field,
  Form,
  HandoffButton,
  QuantityStepper,
  ShellNav,
  StatusBadge,
  SubmitButton,
  useAppFlow,
  useCallTool,
  useHandoff,
  useLayout,
  useSendFollowUpMessage,
  useToolInfo,
  useUpdateModelContext,
  useViewState,
  useWidgetLifecycle,
  useWidgetReady,
  View,
  ViewStack,
} from '../helpers.js';
import { isOrderingEntryResult, type MenuItem, type Store } from './ordering-result.js';
import './widget-style.css';

type ViewName = 'stores' | 'menu' | 'item' | 'cart' | 'review' | 'handoff';

type CartLine = {
  readonly itemId: string;
  readonly quantity: number;
  readonly modifiers: readonly string[];
  readonly note?: string;
};

type CartState = {
  readonly selectedStoreId?: string;
  readonly lines: readonly CartLine[];
  readonly customer: string;
  readonly notes?: string;
  readonly subtotal: number;
  readonly status: 'draft' | 'review' | 'handoff';
  readonly checkoutUrl?: string;
};

const zeroCart: CartState = {
  lines: [],
  customer: 'Guest',
  subtotal: 0,
  status: 'draft',
};

const useCartStore = createViewStore<CartState>('cart', zeroCart);
const useCartRevisionStore = createViewStore('cart_revision', { value: 0 });

function structured<T>(value: unknown): T | undefined {
  return (value as { structuredContent?: T } | undefined)?.structuredContent;
}

function currency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function modifierLabel(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function OrderingFlow() {
  const ready = useWidgetReady();
  const { displayMode, supports, theme } = useLayout();
  const toolInfo = useToolInfo('open_ordering');
  const isPending = !ready || Object.keys(toolInfo).length === 0;
  const entry = isOrderingEntryResult(toolInfo.structuredContent)
    ? toolInfo.structuredContent
    : undefined;
  const flow = useAppFlow<ViewName>({
    key: 'ordering_flow',
    initialView: 'stores',
    views: ['stores', 'menu', 'item', 'cart', 'review', 'handoff'],
  });
  const view = flow.activeView;
  const setView = flow.navigate;
  const handoff = useHandoff();
  const sendFollowUpMessage = useSendFollowUpMessage();
  const updateModelContext = useUpdateModelContext();
  const publishLifecycle = useWidgetLifecycle('ordering-flow');
  const searchStores = useCallTool('search_stores');
  const loadMenu = useCallTool('load_menu');
  const loadItem = useCallTool('load_item');
  const readCart = useCallTool('read_cart');
  const syncCart = useCallTool('sync_cart');
  const prepareCheckout = useCallTool('prepare_checkout');

  const [query, setQuery] = useViewState('query', '');
  const [customer, setCustomer] = useViewState('customer', entry?.customer ?? 'Guest');
  const [selectedStoreId, setSelectedStoreId] = useViewState<string | undefined>(
    'selected_store',
    entry?.stores?.[0]?.id,
  );
  const [selectedItemId, setSelectedItemId] = useViewState<string | undefined>(
    'selected_item',
    entry?.featuredItems?.[0]?.id,
  );
  const cartStore = useCartStore();
  const revisionStore = useCartRevisionStore((state) => state.value);
  const cart =
    cartStore.state.customer === 'Guest' && entry?.customer
      ? { ...cartStore.state, customer: entry.customer }
      : cartStore.state;
  const revision = revisionStore.selected;
  const setCart = cartStore.setState;
  const setRevision = (value: number) => revisionStore.setState({ value });
  const [quantity, setQuantity] = useState(1);
  const [selectedModifiers, setSelectedModifiers] = useState<readonly string[]>([]);
  const [lifecycle, setLifecycle] = useState<'active' | 'submitted'>('active');

  const storeData = structured<{ readonly stores?: readonly Store[] }>(searchStores.data);
  const menuData = structured<{
    readonly stores?: readonly Store[];
    readonly items?: readonly MenuItem[];
  }>(loadMenu.data);
  const itemData = structured<{ readonly items?: readonly MenuItem[] }>(loadItem.data);
  const checkoutData = structured<{ readonly checkoutUrl?: string; readonly cart?: CartState }>(
    prepareCheckout.data,
  );
  const stores = storeData?.stores ?? entry?.stores ?? [];
  const queryText = query.trim().toLowerCase();
  const displayedStores = stores.filter(
    (store) =>
      queryText.length === 0 ||
      store.name.toLowerCase().includes(queryText) ||
      store.cuisine.toLowerCase().includes(queryText),
  );
  const allItems = menuData?.items ?? itemData?.items ?? entry?.featuredItems ?? [];
  const items = allItems.filter((item) => item.storeId === selectedStoreId);
  const currentStore =
    stores.find((store) => store.id === selectedStoreId) ?? menuData?.stores?.[0] ?? stores[0];
  const currentItem = allItems.find((item) => item.id === selectedItemId) ?? items[0];
  const lineItems = useMemo(
    () =>
      cart.lines.map((line) => ({
        ...line,
        item: [...(entry?.featuredItems ?? []), ...allItems].find(
          (item) => item.id === line.itemId,
        ),
      })),
    [cart.lines, entry?.featuredItems, allItems],
  );
  const llmSummary = `${view} view for ${customer}; ${cart.lines.length} cart lines; subtotal ${currency(
    cart.subtotal,
  )}`;
  const canUpdateModelContext = supports?.modelContext === true;

  useEffect(() => {
    if (!entry || !canUpdateModelContext) return;
    // Each call replaces model context, so publish one cohesive snapshot of current surface state.
    void updateModelContext({
      content: [{ type: 'text', text: `Food ordering: ${llmSummary}; ${lifecycle}.` }],
      structuredContent: {
        widget: { name: 'ordering-flow', lifecycle },
        ordering: {
          view,
          customer,
          cartLines: cart.lines.length,
          subtotal: cart.subtotal,
          selectedStoreId: selectedStoreId ?? null,
          selectedItemId: selectedItemId ?? null,
        },
      },
    });
  }, [
    canUpdateModelContext,
    cart.lines.length,
    cart.subtotal,
    customer,
    entry,
    lifecycle,
    llmSummary,
    selectedItemId,
    selectedStoreId,
    updateModelContext,
    view,
  ]);

  async function chooseStore(store: Store) {
    setSelectedStoreId(store.id);
    setView('menu');
    const result = await loadMenu.callTool({ storeId: store.id });
    const loaded = structured<{ readonly items?: readonly MenuItem[] }>(result);
    setSelectedItemId(loaded?.items?.find((item) => item.storeId === store.id)?.id);
  }

  async function chooseItem(item: MenuItem) {
    setSelectedItemId(item.id);
    setSelectedModifiers([]);
    setQuantity(1);
    setView('item');
    await loadItem.callTool({ itemId: item.id });
  }

  async function persistCart(nextCart: CartState, nextView: ViewName) {
    const result = await syncCart.callTool({
      selectedStoreId: nextCart.selectedStoreId,
      lines: nextCart.lines,
      customer: nextCart.customer,
      notes: nextCart.notes,
      subtotal: nextCart.subtotal,
      expectedRevision: revision,
    });
    const synced = structured<{ readonly cart?: CartState; readonly revision?: number }>(result);
    setCart(synced?.cart ?? nextCart);
    setRevision(synced?.revision ?? revision + 1);
    setView(nextView);
  }

  async function addCurrentItem() {
    if (!currentItem) return;
    const nextLines = [
      ...cart.lines,
      {
        itemId: currentItem.id,
        quantity,
        modifiers: selectedModifiers,
      },
    ];
    await persistCart(
      {
        ...cart,
        selectedStoreId: currentStore?.id ?? selectedStoreId,
        lines: nextLines,
        customer,
        subtotal: nextLines.reduce(
          (sum, line) =>
            sum +
            ([...(entry?.featuredItems ?? []), ...allItems].find((item) => item.id === line.itemId)
              ?.price ?? 0) *
              line.quantity,
          0,
        ),
        status: 'draft',
      },
      'cart',
    );
  }

  async function prepareHandoff() {
    const result = await prepareCheckout.callTool({
      selectedStoreId: cart.selectedStoreId,
      lines: cart.lines,
      customer,
      notes: cart.notes,
      subtotal: cart.subtotal,
      expectedRevision: revision,
    });
    const prepared = structured<{
      readonly cart?: CartState;
      readonly revision?: number;
      readonly checkoutUrl?: string;
    }>(result);
    const preparedCart = prepared?.cart ?? cart;
    setCart(preparedCart);
    setRevision(prepared?.revision ?? revision + 1);
    setLifecycle('submitted');
    setView('handoff');
    if (canUpdateModelContext) {
      await publishLifecycle('submitted', {
        view: 'handoff',
        customer,
        cartLines: preparedCart.lines.length,
        subtotal: preparedCart.subtotal,
        selectedStoreId: preparedCart.selectedStoreId ?? null,
        selectedItemId: selectedItemId ?? null,
      });
    }
    if (supports?.followUpMessage) {
      await sendFollowUpMessage({
        prompt: 'Checkout is prepared. Confirm the cart summary and explain the final handoff.',
      });
    }
  }

  if (isPending) {
    return (
      <Feedback status="loading" title="Loading">
        Loading food ordering…
      </Feedback>
    );
  }
  if (toolInfo.isError) {
    return (
      <Feedback status="error" title="Ordering unavailable">
        Could not load food ordering.
      </Feedback>
    );
  }
  if (!entry) {
    return (
      <Feedback status="error" title="Invalid ordering result">
        Food ordering result was incomplete.
      </Feedback>
    );
  }

  return (
    <AppShell
      className={`nw-shell${theme === 'dark' ? ' dark' : ''}`}
      data-llm={llmSummary}
      title="Food Ordering"
      subtitle={entry?.status ?? 'Find a store, build a cart, and hand off checkout.'}
      icon={<BowlIcon />}
      badge={displayMode === 'fullscreen' ? 'Fullscreen' : view}
      footer={
        <>
          <span className="nw-meta">
            <BagIcon />
            {cart.lines.length} items
          </span>
          <span className="nw-meta">Revision {revision}</span>
        </>
      }
    >
      <ShellNav
        activeView={view}
        aria-label="Ordering steps"
        items={(['stores', 'menu', 'cart', 'review', 'handoff'] as const).map((step) => ({
          view: step,
          label: step,
        }))}
        onNavigate={setView}
      />
      <div className="nw-body">
        <ViewStack flow={flow}>
          <View name="stores">
            <Form onSubmit={() => void searchStores.callTool({ query, openOnly: false })}>
              <div className="nw-field-grid">
                <Field className="nw-field" label="Customer">
                  <input
                    className="nw-input"
                    value={customer}
                    onChange={(event) => setCustomer(event.currentTarget.value)}
                  />
                </Field>
                <Field className="nw-field" label="Search">
                  <input
                    className="nw-input"
                    value={query}
                    placeholder="Noodles"
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </Field>
              </div>
              <ActionBar className="nw-actions">
                <SubmitButton
                  type="submit"
                  className="nw-button nw-button-primary"
                  disabled={!ready}
                  pending={searchStores.isPending}
                  pendingLabel="Searching..."
                >
                  <SearchIcon />
                  Search stores
                </SubmitButton>
                <SubmitButton
                  type="button"
                  className="nw-button"
                  pending={readCart.isPending}
                  pendingLabel="Loading..."
                  onClick={async () => {
                    const result = await readCart.callTool({});
                    const stored = structured<{
                      readonly value?: CartState;
                      readonly revision?: number;
                    }>(result);
                    if (stored?.value?.lines) setCart(stored.value);
                    setRevision(stored?.revision ?? revision);
                  }}
                >
                  <RefreshIcon />
                  Load cart
                </SubmitButton>
              </ActionBar>
            </Form>
            <AsyncBoundary
              state={searchStores}
              isEmpty={displayedStores.length === 0}
              empty="No matching stores"
            >
              <StoreList stores={displayedStores} onChoose={chooseStore} />
            </AsyncBoundary>
          </View>

          <View name="menu">
            <SectionHeader title={currentStore?.name ?? 'Menu'} detail={currentStore?.address} />
            <AsyncBoundary
              state={loadMenu}
              isEmpty={items.length === 0}
              empty="No menu items loaded"
            >
              <ItemList items={items} onChoose={chooseItem} />
            </AsyncBoundary>
          </View>

          <View name="item">
            {currentItem ? (
              <>
                <SectionHeader title={currentItem.name} detail={currentItem.description} />
                <div className="nw-field-grid">
                  <Field className="nw-field" label="Quantity">
                    <QuantityStepper value={quantity} min={1} onChange={setQuantity} />
                  </Field>
                  <div className="nw-summary nw-summary-compact">
                    <div className="nw-summary-row">
                      <dt>Price</dt>
                      <dd>{currency(currentItem.price)}</dd>
                    </div>
                  </div>
                </div>
                <ChoiceGroup
                  className="nw-modifier-grid"
                  values={currentItem.modifiers}
                  selected={selectedModifiers}
                  onChange={setSelectedModifiers}
                  labelFor={modifierLabel}
                />
                <ActionBar className="nw-actions">
                  <SubmitButton
                    type="button"
                    className="nw-button nw-button-primary"
                    pending={syncCart.isPending}
                    pendingLabel="Adding..."
                    onClick={addCurrentItem}
                  >
                    <BagIcon />
                    Add to cart
                  </SubmitButton>
                  <button className="nw-button" type="button" onClick={() => setView('menu')}>
                    Back to menu
                  </button>
                </ActionBar>
              </>
            ) : null}
          </View>

          <View name="cart">
            <SectionHeader
              title="Cart"
              detail={`${cart.lines.length} line${cart.lines.length === 1 ? '' : 's'}`}
            />
            <CartSummary lineItems={lineItems} subtotal={cart.subtotal} />
            <Field className="nw-field" label="Notes">
              <input
                className="nw-input"
                value={cart.notes ?? ''}
                placeholder="Utensils, pickup name, or allergies"
                onChange={(event) => setCart({ ...cart, notes: event.currentTarget.value })}
              />
            </Field>
            <ActionBar className="nw-actions">
              <SubmitButton
                type="button"
                className="nw-button"
                pending={syncCart.isPending}
                pendingLabel="Saving..."
                onClick={() => persistCart({ ...cart, customer, status: 'draft' }, 'review')}
              >
                <SaveIcon />
                Save cart
              </SubmitButton>
              <SubmitButton
                type="button"
                className="nw-button nw-button-primary"
                disabled={cart.lines.length === 0}
                pending={prepareCheckout.isPending}
                pendingLabel="Preparing..."
                onClick={prepareHandoff}
              >
                <ExternalIcon />
                Prepare checkout
              </SubmitButton>
            </ActionBar>
          </View>

          <View name="review">
            <SectionHeader
              title="Review order"
              detail={`${cart.lines.length} line${cart.lines.length === 1 ? '' : 's'}`}
            />
            <CartSummary lineItems={lineItems} subtotal={cart.subtotal} />
            <ActionBar className="nw-actions">
              <button className="nw-button" type="button" onClick={() => setView('cart')}>
                Edit cart
              </button>
              <SubmitButton
                type="button"
                className="nw-button nw-button-primary"
                disabled={cart.lines.length === 0}
                pending={prepareCheckout.isPending}
                pendingLabel="Preparing..."
                onClick={prepareHandoff}
              >
                <ExternalIcon />
                Prepare checkout
              </SubmitButton>
            </ActionBar>
          </View>

          <View name="handoff">
            <SectionHeader
              title="Checkout handoff"
              detail="Payment stays with the ordering site."
            />
            <CartSummary lineItems={lineItems} subtotal={cart.subtotal} />
            <p className="nw-note">
              The MCP App prepared a synthetic checkout URL and will open only the allowlisted
              example domain.
            </p>
            <ActionBar className="nw-actions">
              <HandoffButton
                handoff={handoff}
                target={checkoutData?.checkoutUrl ?? cart.checkoutUrl ?? ''}
                className="nw-button nw-button-primary"
                type="button"
                pendingLabel="Opening..."
              >
                <ExternalIcon />
                Continue checkout
              </HandoffButton>
              <button
                className="nw-button"
                type="button"
                onClick={() =>
                  sendFollowUpMessage({
                    prompt: `Summarize my food order for ${customer} before checkout.`,
                  })
                }
              >
                <SparkIcon />
                Ask assistant
              </button>
            </ActionBar>
          </View>
        </ViewStack>
      </div>
    </AppShell>
  );
}

function SectionHeader({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <div className="nw-section-head">
      <p className="nw-section-title">{title}</p>
      {detail ? <p className="nw-section-detail">{detail}</p> : null}
    </div>
  );
}

function StoreList({
  stores,
  onChoose,
}: {
  readonly stores: readonly Store[];
  readonly onChoose: (store: Store) => void;
}) {
  return (
    <DataList className="nw-menu-list">
      {stores.map((store) => (
        <DataCard
          as="button"
          className="nw-menu-item"
          key={store.id}
          type="button"
          onClick={() => onChoose(store)}
        >
          <span>
            <span className="nw-menu-name">{store.name}</span>
            <span className="nw-menu-desc">
              {store.cuisine} · {store.address}
            </span>
          </span>
          <StatusBadge className="nw-status" tone={store.open ? 'success' : 'neutral'}>
            {store.open ? `${store.etaMinutes}m` : 'Closed'}
          </StatusBadge>
        </DataCard>
      ))}
    </DataList>
  );
}

function ItemList({
  items,
  onChoose,
}: {
  readonly items: readonly MenuItem[];
  readonly onChoose: (item: MenuItem) => void;
}) {
  return (
    <DataList className="nw-menu-list">
      {items.map((item) => (
        <DataCard
          as="button"
          className="nw-menu-item"
          key={item.id}
          type="button"
          onClick={() => onChoose(item)}
        >
          <span>
            <span className="nw-menu-name">{item.name}</span>
            <span className="nw-menu-desc">{item.description}</span>
          </span>
          <span className="nw-price">{currency(item.price)}</span>
        </DataCard>
      ))}
    </DataList>
  );
}

function CartSummary({
  lineItems,
  subtotal,
}: {
  readonly lineItems: readonly (CartLine & { readonly item?: MenuItem })[];
  readonly subtotal: number;
}) {
  return (
    <dl className="nw-summary">
      {lineItems.length === 0 ? (
        <div className="nw-summary-row">
          <dt>No items yet</dt>
          <dd>{currency(0)}</dd>
        </div>
      ) : (
        lineItems.map((line, index) => (
          <div className="nw-summary-row" key={`${line.itemId}-${index}`}>
            <dt>
              {line.quantity} x {line.item?.name ?? line.itemId}
              {line.modifiers.length > 0 ? (
                <span className="nw-line-note">{line.modifiers.map(modifierLabel).join(', ')}</span>
              ) : null}
            </dt>
            <dd>{currency((line.item?.price ?? 0) * line.quantity)}</dd>
          </div>
        ))
      )}
      <div className="nw-summary-row nw-total">
        <dt>Subtotal</dt>
        <dd>{currency(subtotal)}</dd>
      </div>
    </dl>
  );
}

function BowlIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 11h16a7 7 0 0 1-7 7h-2a7 7 0 0 1-7-7Z" />
      <path d="M7 21h10" />
      <path d="M8 6c0-1 1-1 1-2" />
      <path d="M12 6c0-1 1-1 1-2" />
      <path d="M16 6c0-1 1-1 1-2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
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

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8h12l-1 12H7L6 8Z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 4h12l2 2v14H5V4Z" />
      <path d="M8 4v6h8" />
      <path d="M8 20v-5h8v5" />
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

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  );
}
