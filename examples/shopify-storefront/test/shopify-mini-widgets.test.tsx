// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetail from '../src/views/product-detail.js';
import ProductRecommendations from '../src/views/product-recommendations.js';
import StoreAnswer from '../src/views/store-answer.js';

type ToolResult = { readonly structuredContent?: unknown; readonly isError?: boolean };

const getProduct = vi.fn();
const createCheckout = vi.fn();
const openExternal = vi.fn();
let toolResult: ToolResult;
let layoutTheme: 'light' | 'dark';
let root: Root | undefined;

vi.mock('../src/helpers.js', () => ({
  Form: ({ children, ...props }: { readonly children?: ReactNode }) => h('form', props, children),
  useCallTool: (name: string) => ({
    callTool: name === 'get_product' ? getProduct : createCheckout,
    isPending: false,
  }),
  useLayout: () => ({ theme: layoutTheme, displayMode: 'inline' }),
  useOpenExternal: () => openExternal,
  useToolInfo: () => toolResult,
  useViewState: <T,>(_key: string, initial: T) => useState(initial),
  useWidgetReady: () => true,
}));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toolResult = {};
  layoutTheme = 'light';
  getProduct.mockReset();
  createCheckout.mockReset();
  openExternal.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
});

function render(component: () => ReactNode, result: ToolResult): string {
  toolResult = result;
  root = createRoot(document.querySelector('#root') as HTMLElement);
  act(() => root?.render(h(component)));
  return document.body.textContent ?? '';
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

function product(index: number) {
  return {
    id: `gid://shopify/Product/${index}`,
    handle: `trail-shoe-${index}`,
    title: `Trail shoe ${index}`,
    description: `Built for wet trails, option ${index}.`,
    availableForSale: true,
    featuredImage: {
      url: `https://cdn.shopify.com/shoe-${index}.jpg`,
      altText: `Trail shoe ${index}`,
    },
    minimumPrice: { amount: `${80 + index}.00`, currencyCode: 'USD' },
    maximumPrice: { amount: `${90 + index}.00`, currencyCode: 'USD' },
    variantCount: 1,
    variantsComplete: true,
    vendor: 'Noodle Sports',
    productType: 'Shoes',
    tags: ['trail'],
    onlineStoreUrl: `https://merchant.myshopify.com/products/trail-shoe-${index}`,
    variants: [
      {
        id: `gid://shopify/ProductVariant/${index}`,
        title: 'Blue / 42',
        availableForSale: true,
        price: { amount: `${80 + index}.00`, currencyCode: 'USD' },
        compareAtPrice: index === 1 ? { amount: '99.00', currencyCode: 'USD' } : null,
        selectedOptions: [
          { name: 'Color', value: 'Blue' },
          { name: 'Size', value: '42' },
        ],
      },
    ],
  };
}

function searchResult(count = 3): ToolResult {
  return {
    structuredContent: {
      status: 'ok',
      storeOrigin: 'https://merchant.myshopify.com',
      errors: [],
      products: Array.from({ length: count }, (_, index) => product(index + 1)),
    },
  };
}

function detailResult(): ToolResult {
  return {
    structuredContent: {
      status: 'ok',
      storeOrigin: 'https://merchant.myshopify.com',
      errors: [],
      product: { ...product(1), images: [] },
    },
  };
}

describe('Shopify recommendation mini-widget', () => {
  it('shows at most three matches and no storefront, filter, cart, or checkout controls', () => {
    const text = render(ProductRecommendations, searchResult());

    expect(text).not.toContain('Top matches');
    expect(document.querySelector('h2')).toBeNull();
    expect(text).toContain('Trail shoe 1');
    expect(text).toContain('Trail shoe 3');
    expect(text).not.toContain('Trail shoe 4');
    expect(document.querySelectorAll('[data-product-card]')).toHaveLength(3);
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
    expect(text).not.toMatch(/cart|checkout|sort|filter/i);
  });

  it('applies the light host theme to the entire widget root', () => {
    render(ProductRecommendations, searchResult(1));
    expect(document.querySelector('main')?.getAttribute('data-theme')).toBe('light');
  });

  it('applies the dark host theme to the entire widget root', () => {
    layoutTheme = 'dark';
    render(ProductRecommendations, searchResult(1));
    expect(document.querySelector('main')?.getAttribute('data-theme')).toBe('dark');
  });

  it('progresses from a recommendation into only the selected product detail', async () => {
    getProduct.mockResolvedValue(detailResult());
    render(ProductRecommendations, searchResult());

    await act(async () => button('Details').click());

    expect(getProduct).toHaveBeenCalledWith({ handle: 'trail-shoe-1' });
    expect(document.body.textContent).toContain('Built for wet trails, option 1.');
    expect(document.querySelectorAll('[data-product-card]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Trail shoe 2');
  });
});

describe('Shopify product-detail mini-widget', () => {
  it('reveals a one-item checkout summary only after the shopper chooses the item', async () => {
    const text = render(ProductDetail, detailResult());
    expect(text).toContain('Trail shoe 1');
    expect(text).toContain('Built for wet trails');
    expect(text).not.toContain('Checkout summary');
    expect(createCheckout).not.toHaveBeenCalled();

    await act(async () => button('Choose this item').click());

    expect(document.body.textContent).toContain('Checkout summary');
    expect(document.body.textContent).toContain('1 × Trail shoe 1');
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('creates one Shopify checkout only after the explicit final action', async () => {
    createCheckout.mockResolvedValue({
      structuredContent: {
        status: 'ready',
        checkoutUrl: 'https://merchant.myshopify.com/checkouts/example',
        subtotal: { amount: '81.00', currencyCode: 'USD' },
        total: { amount: '86.00', currencyCode: 'USD' },
        errors: [],
        warnings: [],
      },
    });
    render(ProductDetail, detailResult());

    await act(async () => button('Choose this item').click());
    await act(async () => button('Continue to Shopify').click());

    expect(createCheckout).toHaveBeenCalledWith({
      lines: [{ merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1 }],
    });
    expect(openExternal).toHaveBeenCalledWith('https://merchant.myshopify.com/checkouts/example');
    expect(JSON.stringify(createCheckout.mock.calls)).not.toContain('gid://shopify/Cart/');
  });

  it('fails closed for malformed product data', () => {
    const text = render(ProductDetail, {
      structuredContent: {
        status: 'ok',
        storeOrigin: 'https://merchant.myshopify.com',
        errors: [],
        product: { id: 'missing-everything-else' },
      },
    });

    expect(text).toContain('Product details are unavailable');
    expect(document.querySelector('button')).toBeNull();
  });
});

describe('Shopify Storefront MCP answer widget', () => {
  it('renders the bounded answer added by Noodle to a headless upstream tool', () => {
    const text = render(StoreAnswer, {
      structuredContent: {
        status: 'ok',
        source: 'faq',
        query: 'What is your return policy?',
        shop: null,
        policies: [],
        answer: 'Unused items may be returned within 30 days.',
        items: [],
        errors: [],
        storeOrigin: 'https://merchant.myshopify.com',
      },
    });

    expect(text).toContain('Answer from this store');
    expect(text).toContain('What is your return policy?');
    expect(text).toContain('Unused items may be returned within 30 days.');
    expect(document.querySelector('button')).toBeNull();
  });

  it('renders bounded published-content evidence when the FAQ source has no answer', () => {
    const text = render(StoreAnswer, {
      structuredContent: {
        status: 'ok',
        source: 'published_content',
        query: 'How should I care for a snowboard?',
        shop: null,
        policies: [],
        answer: '',
        items: [
          {
            kind: 'article',
            id: 'gid://shopify/Article/1',
            handle: 'waxing-basics',
            title: 'Waxing basics',
            body: 'Wax every three to five riding days.',
            url: 'https://merchant.myshopify.com/blogs/guides/waxing-basics',
            publishedAt: '2026-08-19T10:00:00Z',
            tags: ['care'],
            section: 'Guides',
          },
        ],
        errors: [],
        storeOrigin: 'https://merchant.myshopify.com',
      },
    });

    expect(text).toContain('Published evidence from this store');
    expect(text).toContain('Waxing basics');
    expect(text).toContain('Wax every three to five riding days.');
    expect(document.querySelector('a')?.getAttribute('href')).toBe(
      'https://merchant.myshopify.com/blogs/guides/waxing-basics',
    );
    expect(document.querySelector('button')).toBeNull();
  });

  it('renders one canonical policy with its authoritative source link', () => {
    const text = render(StoreAnswer, {
      structuredContent: {
        status: 'ok',
        source: 'canonical_policy',
        query: 'What is your shipping policy?',
        shop: null,
        policies: [
          {
            kind: 'shipping',
            title: 'Shipping policy',
            body: 'Orders ship within two business days.',
            url: 'https://merchant.myshopify.com/policies/shipping-policy',
          },
        ],
        answer: '',
        items: [],
        errors: [],
        storeOrigin: 'https://merchant.myshopify.com',
      },
    });

    expect(text).toContain('Published policy from this store');
    expect(text).toContain('Shipping policy');
    expect(text).toContain('Orders ship within two business days.');
    expect(document.querySelector('a')?.getAttribute('href')).toBe(
      'https://merchant.myshopify.com/policies/shipping-policy',
    );
  });

  it('fails closed when the upstream-shaped output is malformed', () => {
    expect(render(StoreAnswer, { structuredContent: { answer: { unsafe: true } } })).toContain(
      'Store information is unavailable',
    );
  });

  it('renders a neutral no-answer state without presenting an upstream sentinel', () => {
    const text = render(StoreAnswer, {
      structuredContent: {
        status: 'not_found',
        source: 'none',
        query: 'Do you offer repairs?',
        shop: null,
        policies: [],
        answer: '',
        items: [],
        errors: [],
        storeOrigin: 'https://merchant.myshopify.com',
      },
    });

    expect(text).toContain('This store has not published an answer');
    expect(text).not.toContain('[]');
    expect(text).not.toContain('Store information is unavailable');
  });
});
