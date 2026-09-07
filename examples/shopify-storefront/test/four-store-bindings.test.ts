import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../../packages/compiler/src/index.js';
import { compileConnectors } from '../../../packages/connector-defs/src/index.js';
import {
  type CredentialBroker,
  type CredentialRequest,
  type DownstreamCredential,
  executePreparedTool,
  executeTool,
  InMemoryConnectorRegistry,
  isConfirmationRequired,
  prepareToolForConfirmation,
} from '../../../packages/runtime/src/index.js';
import app, { shopifyStorefrontMcp } from '../src/server.js';
import { SHOPIFY_CUSTOMER_BINDINGS, type ShopifyCustomerBinding } from './customer-bindings.js';

function fixtureProduct(binding: ShopifyCustomerBinding) {
  const origin = binding.env.SHOPIFY_STORE_ORIGIN;
  if (origin === undefined) throw new Error('expected Shopify store origin');
  const handle = `${binding.customer}-trail-mug`;
  return {
    id: `gid://shopify/Product/${binding.customer}`,
    handle,
    title: `${binding.customer} trail mug`,
    description: `A product isolated to ${binding.customer}.`,
    availableForSale: true,
    featuredImage: {
      url: `https://cdn.shopify.com/${binding.customer}/trail-mug.jpg`,
      altText: `${binding.customer} trail mug`,
    },
    priceRange: {
      minVariantPrice: { amount: '18.00', currencyCode: 'USD' },
      maxVariantPrice: { amount: '18.00', currencyCode: 'USD' },
    },
    variantsCount: { count: 1 },
    variants: {
      nodes: [
        {
          id: `gid://shopify/ProductVariant/${binding.customer}`,
          title: 'Default',
          availableForSale: true,
          price: { amount: '18.00', currencyCode: 'USD' },
          compareAtPrice: null,
          selectedOptions: [{ name: 'Color', value: binding.customer }],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    vendor: binding.customer,
    productType: 'Drinkware',
    tags: [binding.customer],
    onlineStoreUrl: `${origin}/products/${handle}`,
    images: {
      nodes: [
        {
          url: `https://cdn.shopify.com/${binding.customer}/trail-mug-detail.jpg`,
          altText: `${binding.customer} trail mug detail`,
        },
      ],
    },
  };
}

function customerCatalog(binding: ShopifyCustomerBinding) {
  const catalog = structuredClone(app.toConnectorCatalog());
  if (catalog === undefined) throw new Error('expected Shopify connector catalog');
  const product = fixtureProduct(binding);
  const origin = binding.env.SHOPIFY_STORE_ORIGIN;
  if (origin === undefined) throw new Error('expected Shopify store origin');

  for (const connector of catalog.connectors) {
    if (connector.id === 'shopify_storefront') {
      connector.operations.search_products.fake = {
        response: {
          data: {
            search: {
              nodes: [product],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 1,
              productFilters: [],
            },
          },
        },
      };
      connector.operations.get_product.fake = { response: { data: { product } } };
      connector.operations.get_shop_information.fake = {
        response: {
          data: {
            shop: {
              name: `${binding.customer} shop`,
              description: `${binding.customer} storefront`,
              primaryDomain: { url: origin },
              shipsToCountries: ['US'],
              shippingPolicy: {
                title: `${binding.customer} shipping policy`,
                body: `${binding.customer} orders ship within two business days.`,
                url: `${origin}/policies/shipping-policy`,
              },
            },
          },
        },
      };
      connector.operations.search_store_content.fake = {
        response: {
          data: {
            search: {
              nodes: [
                {
                  __typename: 'Page',
                  id: `gid://shopify/Page/${binding.customer}`,
                  handle: 'repairs-and-parts',
                  title: `${binding.customer} repairs and parts`,
                  body: `${binding.customer} publishes replacement-part guidance.`,
                  onlineStoreUrl: `${origin}/pages/repairs-and-parts`,
                  updatedAt: '2026-08-26T00:00:00Z',
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 1,
            },
          },
        },
      };
      connector.operations.create_cart.fake = {
        response: {
          data: {
            cartCreate: {
              cart: {
                checkoutUrl: `${origin}/checkouts/${binding.customer}`,
                cost: {
                  subtotalAmount: { amount: '18.00', currencyCode: 'USD' },
                  totalAmount: { amount: '19.44', currencyCode: 'USD' },
                },
              },
              userErrors: [],
              warnings: [
                {
                  code: 'LIMITED_STOCK',
                  message: `${binding.customer} has limited stock.`,
                },
              ],
            },
          },
        },
      };
    }
    if (connector.id === 'shopify_storefront_mcp') {
      connector.operations.search_shop_policies_and_faqs.fake = {
        text: '[]',
      };
    }
  }
  return catalog;
}

async function executeCustomerJourney(binding: ShopifyCustomerBinding) {
  const connectors = compileConnectors(JSON.stringify(customerCatalog(binding)), { mode: 'fake' });
  if (!connectors.ok) throw new Error(JSON.stringify(connectors.errors));
  const compiled = compileManifest(await app.toManifest(), {
    catalog: new InMemoryCatalog(connectors.catalog),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

  const credentialRequests: CredentialRequest[] = [];
  const broker: CredentialBroker = {
    getCredential(request): Promise<DownstreamCredential> {
      credentialRequests.push(request);
      return Promise.resolve({ token: `${binding.customer}-private-token` });
    },
  };
  const deps = {
    connectors: new InMemoryConnectorRegistry(connectors.connectors),
    broker,
    env: binding.env,
    tenantId: binding.customer,
    deploymentId: `${binding.customer}-shopify`,
  };
  const product = fixtureProduct(binding);

  const search = await executeTool(
    compiled.artifact,
    'search_products',
    {
      query: 'mug',
      first: 3,
      sortKey: 'RELEVANCE',
      reverse: false,
      unavailableProducts: 'HIDE',
    },
    deps,
  );
  const detail = await executeTool(
    compiled.artifact,
    'show_product',
    { handle: product.handle },
    deps,
  );
  const policy = await executeTool(
    compiled.artifact,
    'ask_store',
    { query: 'What is the shipping policy?', source: 'policy', policy: 'shipping' },
    deps,
  );
  const faq = await executeTool(
    compiled.artifact,
    'ask_store',
    { query: 'What is the return policy?', source: 'answer' },
    deps,
  );
  const preparedCheckout = await prepareToolForConfirmation(
    compiled.artifact,
    'create_checkout',
    {
      lines: [{ merchandiseId: product.variants.nodes[0]?.id, quantity: 1 }],
      note: `checkout for ${binding.customer}`,
    },
    deps,
  );
  if (!isConfirmationRequired(preparedCheckout)) {
    throw new Error(`expected checkout confirmation: ${JSON.stringify(preparedCheckout)}`);
  }
  expect(preparedCheckout).toMatchObject({ status: 'confirmation_required' });
  const checkout = await executePreparedTool(
    compiled.artifact,
    preparedCheckout.continuation,
    deps,
  );

  return { binding, credentialRequests, search, detail, policy, faq, checkout };
}

describe('four-store reusable deployment proof', () => {
  it('binds four isolated Shopify stores to one unchanged authored source', async () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
    const manifest = JSON.stringify(await app.toManifest());
    const connector = JSON.stringify(shopifyStorefrontMcp.mcpDef);
    const origins = new Set<string>();

    expect(SHOPIFY_CUSTOMER_BINDINGS).toHaveLength(4);
    for (const binding of SHOPIFY_CUSTOMER_BINDINGS) {
      const origin = binding.env.SHOPIFY_STORE_ORIGIN;
      const endpoint = binding.env.SHOPIFY_STOREFRONT_MCP_ENDPOINT;
      expect(origin).toBeDefined();
      expect(endpoint).toBeDefined();
      if (origin === undefined || endpoint === undefined) continue;
      expect(new URL(endpoint).origin).toBe(origin);
      expect(new URL(endpoint).pathname).toBe('/api/mcp');
      origins.add(origin);
    }

    expect(origins.size).toBe(4);
    expect(source).not.toContain('alpha-outdoors');
    expect(source).not.toContain('bravo-home');
    expect(source).not.toContain('charlie-beauty');
    expect(source).not.toContain('delta-pets');
    expect(manifest).toContain('${env.SHOPIFY_STORE_ORIGIN}');
    expect(connector).toContain('${env.SHOPIFY_STOREFRONT_MCP_ENDPOINT}');
    expect(connector).toContain('${env.SHOPIFY_STORE_ORIGIN}');
  });

  it('keeps all store-specific values out of the compiled public contract', async () => {
    const serialized = `${JSON.stringify(await app.toManifest())}\n${JSON.stringify(
      app.toConnectorCatalog(),
    )}`;
    for (const binding of SHOPIFY_CUSTOMER_BINDINGS) {
      expect(serialized).not.toContain(binding.customer);
      for (const value of Object.values(binding.env)) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it('executes the complete governed shopper path concurrently for all four bindings without leakage', async () => {
    const journeys = await Promise.all(SHOPIFY_CUSTOMER_BINDINGS.map(executeCustomerJourney));

    for (const journey of journeys) {
      const origin = journey.binding.env.SHOPIFY_STORE_ORIGIN;
      if (origin === undefined) throw new Error('expected Shopify store origin');
      expect(journey.search, JSON.stringify(journey.search)).toMatchObject({
        ok: true,
        output: {
          status: 'ok',
          storeOrigin: origin,
          products: [{ title: `${journey.binding.customer} trail mug` }],
        },
      });
      expect(journey.detail).toMatchObject({
        ok: true,
        output: {
          status: 'ok',
          storeOrigin: origin,
          product: { vendor: journey.binding.customer },
        },
      });
      expect(journey.policy).toMatchObject({
        ok: true,
        output: {
          status: 'ok',
          source: 'canonical_policy',
          storeOrigin: origin,
          policies: [
            {
              kind: 'shipping',
              title: `${journey.binding.customer} shipping policy`,
              body: `${journey.binding.customer} orders ship within two business days.`,
              url: `${origin}/policies/shipping-policy`,
            },
          ],
        },
      });
      expect(journey.faq).toMatchObject({
        ok: true,
        output: {
          status: 'ok',
          source: 'published_content',
          storeOrigin: origin,
          answer: '',
          items: [
            {
              title: `${journey.binding.customer} repairs and parts`,
              body: `${journey.binding.customer} publishes replacement-part guidance.`,
              url: `${origin}/pages/repairs-and-parts`,
            },
          ],
        },
      });
      expect(journey.checkout).toMatchObject({
        status: 'completed',
        output: {
          status: 'ready',
          checkoutUrl: `${origin}/checkouts/${journey.binding.customer}`,
          warnings: [`LIMITED_STOCK: ${journey.binding.customer} has limited stock.`],
        },
      });
      expect(
        journey.credentialRequests.map(({ connectorId, operation }) => ({
          connectorId,
          operation,
        })),
      ).toEqual([
        { connectorId: 'shopify_storefront', operation: 'search_products' },
        { connectorId: 'shopify_response_normalizer', operation: 'products' },
        { connectorId: 'shopify_storefront', operation: 'get_product' },
        { connectorId: 'shopify_response_normalizer', operation: 'product' },
        { connectorId: 'shopify_storefront', operation: 'get_shop_information' },
        { connectorId: 'shopify_response_normalizer', operation: 'shop' },
        { connectorId: 'shopify_response_normalizer', operation: 'store_knowledge' },
        {
          connectorId: 'shopify_storefront_mcp',
          operation: 'search_shop_policies_and_faqs',
        },
        { connectorId: 'shopify_response_normalizer', operation: 'store_answer' },
        { connectorId: 'shopify_storefront', operation: 'search_store_content' },
        { connectorId: 'shopify_response_normalizer', operation: 'content' },
        { connectorId: 'shopify_response_normalizer', operation: 'store_knowledge' },
        { connectorId: 'shopify_storefront', operation: 'create_cart' },
        { connectorId: 'shopify_response_normalizer', operation: 'checkout' },
      ]);
      for (const request of journey.credentialRequests) {
        expect(request).toMatchObject({
          tenantId: journey.binding.customer,
          deploymentId: `${journey.binding.customer}-shopify`,
        });
      }

      const serialized = JSON.stringify(journey);
      expect(serialized).not.toContain(`${journey.binding.customer}-private-token`);
      expect(serialized).not.toMatch(/gid:\/\/shopify\/Cart|cart[_-]?id/i);
      for (const other of SHOPIFY_CUSTOMER_BINDINGS) {
        if (other.customer === journey.binding.customer) continue;
        expect(serialized).not.toContain(other.customer);
        for (const value of Object.values(other.env)) {
          if (Object.values(journey.binding.env).includes(value)) continue;
          expect(serialized).not.toContain(value);
        }
      }
    }
  });
});
