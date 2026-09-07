import {
  annotations,
  connector,
  embeddedAssistant,
  noodleManaged,
  publicWebsite,
  secret,
  server,
  tool,
  when,
  z,
} from '@noodleseed/one';
import {
  SHOPIFY_AGENT_GUIDE,
  SHOPIFY_ASSISTANT_INSTRUCTIONS,
  SHOPIFY_SERVER_INSTRUCTIONS,
} from './shopify-assistant.js';
import {
  SHOPIFY_STORE_ORIGIN,
  SHOPIFY_STOREFRONT_API_VERSION,
  SHOPIFY_STOREFRONT_MCP_ENDPOINT,
} from './shopify-config.js';
import {
  normalizeStoreContentSearchOperation,
  normalizeStoreContentSearchResponse,
} from './shopify-content-responses.js';
import {
  normalizeStoreAnswerOperation,
  normalizeStoreKnowledgeOperation,
} from './shopify-mcp-responses.js';
import {
  CART_CREATE_MUTATION,
  PRODUCT_DETAIL_QUERY,
  PRODUCT_RECOMMENDATIONS_QUERY,
  PRODUCT_SEARCH_QUERY,
  SHOP_INFORMATION_QUERY,
  STORE_CONTENT_SEARCH_QUERY,
} from './shopify-queries.js';
import {
  normalizeProductRecommendationsOperation,
  normalizeProductRecommendationsResponse,
} from './shopify-recommendation-responses.js';
import {
  normalizeCheckoutOperation,
  normalizeCheckoutResponse,
  normalizeProductDetailOperation,
  normalizeProductDetailResponse,
  normalizeProductSearchOperation,
  normalizeProductSearchResponse,
  normalizeShopInformationOperation,
  normalizeShopInformationResponse,
} from './shopify-responses.js';

export {
  CART_CREATE_MUTATION,
  normalizeCheckoutResponse,
  normalizeProductDetailResponse,
  normalizeProductRecommendationsResponse,
  normalizeProductSearchResponse,
  normalizeShopInformationResponse,
  normalizeStoreContentSearchResponse,
  PRODUCT_DETAIL_QUERY,
  PRODUCT_RECOMMENDATIONS_QUERY,
  PRODUCT_SEARCH_QUERY,
  SHOP_INFORMATION_QUERY,
  STORE_CONTENT_SEARCH_QUERY,
};

const SHOPIFY_API_PATH = `/api/${SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`;
const SHOPIFY_WIDGET_DOMAIN = 'https://shopify.noodleseed.cloud.noodleseed.dev';

const moneySchema = z.object({ amount: z.string(), currencyCode: z.string() });
const selectedOptionSchema = z.object({ name: z.string(), value: z.string() });
const variantSchema = z.object({
  id: z.string(),
  title: z.string(),
  availableForSale: z.boolean(),
  price: moneySchema,
  compareAtPrice: moneySchema.nullable(),
  selectedOptions: z.array(selectedOptionSchema).max(20),
});
const productSchema = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  description: z.string(),
  availableForSale: z.boolean(),
  featuredImage: z.object({ url: z.string(), altText: z.string().nullable() }).nullable(),
  minimumPrice: moneySchema,
  maximumPrice: moneySchema,
  variantCount: z.number().int().min(0),
  variantsComplete: z.boolean(),
  variants: z.array(variantSchema).max(100),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()).max(50),
  onlineStoreUrl: z.string().nullable(),
});
const filterSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  values: z
    .array(
      z.object({ id: z.string(), label: z.string(), count: z.number().int(), input: z.string() }),
    )
    .max(50),
});
const normalizedProductSearchOutput = z.object({
  status: z.enum(['ok', 'error']),
  products: z.array(productSchema).max(20),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  totalCount: z.number().int().min(0),
  filters: z.array(filterSchema).max(20),
  errors: z.array(z.string()).max(20),
});
const productSearchOutput = normalizedProductSearchOutput.extend({
  query: z.string(),
  sortKey: z.enum(['RELEVANCE', 'PRICE']),
  reverse: z.boolean(),
  unavailableProducts: z.enum(['HIDE', 'LAST', 'SHOW']),
  storeOrigin: z.string(),
});
const normalizedRecommendationsOutput = z.object({
  status: z.enum(['ok', 'error']),
  products: z.array(productSchema).max(3),
  errors: z.array(z.string()).max(20),
});
const recommendationsOutput = normalizedRecommendationsOutput.extend({
  storeOrigin: z.string(),
});
const storeContentItemSchema = z.object({
  kind: z.enum(['page', 'article']),
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  body: z.string().max(4_000),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  tags: z.array(z.string()).max(50),
  section: z.string().nullable(),
});
const normalizedStoreContentSearchOutput = z.object({
  status: z.enum(['ok', 'error']),
  items: z.array(storeContentItemSchema).max(20),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  totalCount: z.number().int().min(0),
  errors: z.array(z.string()).max(20),
});
const normalizedStoreAnswerOutput = z.object({
  status: z.enum(['ok', 'not_found', 'error']),
  answer: z.string().max(12_000),
  errors: z.array(z.string()).max(5),
});
const storeContentSearchOutput = normalizedStoreContentSearchOutput.extend({
  query: z.string(),
  storeOrigin: z.string(),
});
const productDetailOutput = z.object({
  status: z.enum(['ok', 'not_found', 'error']),
  product: productSchema
    .extend({
      images: z.array(z.object({ url: z.string(), altText: z.string().nullable() })).max(12),
    })
    .nullable(),
  errors: z.array(z.string()).max(20),
  storeOrigin: z.string(),
});
const policyKindSchema = z.enum(['contact', 'privacy', 'refund', 'shipping', 'terms']);
const policySchema = z.object({
  kind: policyKindSchema,
  title: z.string(),
  body: z.string().max(4_000),
  url: z.string(),
});
const shopSchema = z.object({
  name: z.string(),
  description: z.string().max(2_000),
  primaryDomain: z.string(),
  shipsToCountries: z.array(z.string()).max(250),
});
const shopInformationOutput = z.object({
  status: z.enum(['ok', 'error']),
  shop: shopSchema.nullable(),
  policies: z.array(policySchema).max(5),
  errors: z.array(z.string()).max(20),
  storeOrigin: z.string(),
});
const normalizedShopInformationOutput = shopInformationOutput.omit({ storeOrigin: true });
const normalizedStoreKnowledgeOutput = z.object({
  status: z.enum(['ok', 'not_found', 'error']),
  source: z.enum(['store_information', 'canonical_policy', 'faq', 'published_content', 'none']),
  shop: shopSchema.nullable(),
  policies: z.array(policySchema).max(1),
  answer: z.string().max(12_000),
  items: z.array(storeContentItemSchema).max(3),
  errors: z.array(z.string()).max(20),
});
const checkoutOutput = z.object({
  status: z.enum(['ready', 'error']),
  checkoutUrl: z.string().nullable(),
  subtotal: moneySchema.nullable(),
  total: moneySchema.nullable(),
  errors: z.array(z.string()).max(20),
  warnings: z.array(z.string()).max(20),
});
const cartLineSchema = z.object({
  merchandiseId: z.string(),
  quantity: z.number().int().min(1).max(99),
});

/**
 * A frozen, curated wrapper around Shopify's public Storefront MCP policy/FAQ tool. Shopify supplies
 * no MCP App for this tool; the outward `ask_store` tool below owns its stable contract and view.
 */
export const shopifyStorefrontMcp = connector('shopify_storefront_mcp')
  .version('1.0.0')
  .mcp({
    endpoint: SHOPIFY_STOREFRONT_MCP_ENDPOINT,
    allowedOrigins: [SHOPIFY_STORE_ORIGIN],
    maxResponseBytes: 64 * 1024,
    operations: {
      search_shop_policies_and_faqs: {
        type: 'read',
        tool: 'search_shop_policies_and_faqs',
        result: 'text',
        input: z.object({
          query: z.string().min(1).max(500),
          context: z.string().max(2_000).optional(),
        }),
        fake: {
          text: 'Unused items may be returned within 30 days with proof of purchase.',
        },
      },
    },
  });

export const shopifyStorefront = connector('shopify_storefront')
  .version('1.0.0')
  .http({
    baseUrl: SHOPIFY_STORE_ORIGIN,
    allowedOrigins: [SHOPIFY_STORE_ORIGIN],
    auth: {
      kind: 'apiKey',
      header: 'Shopify-Storefront-Private-Token',
      secret: secret('SHOPIFY_STOREFRONT_PRIVATE_TOKEN'),
    },
    operations: {
      search_products: {
        type: 'read',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        input: z.object({
          query: z.string(),
          first: z.number().int().min(1).max(20),
          after: z.string().optional(),
          sortKey: z.enum(['RELEVANCE', 'PRICE']),
          reverse: z.boolean(),
          unavailableProducts: z.enum(['HIDE', 'LAST', 'SHOW']),
        }),
        output: z.object({ raw: z.unknown() }),
        request: {
          query: PRODUCT_SEARCH_QUERY,
          variables: {
            query: '${args.query}',
            first: '${args.first}',
            after: '${args.after}',
            sortKey: '${args.sortKey}',
            reverse: '${args.reverse}',
            unavailableProducts: '${args.unavailableProducts}',
          },
        },
        response: { raw: '${response}' },
      },
      get_product: {
        type: 'read',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        input: z.object({ handle: z.string().min(1).max(255) }),
        output: z.object({ raw: z.unknown() }),
        request: {
          query: PRODUCT_DETAIL_QUERY,
          variables: { handle: '${args.handle}' },
        },
        response: { raw: '${response}' },
      },
      get_recommendations: {
        type: 'read',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        input: z.object({ ids: z.array(z.string()).min(1).max(3) }),
        output: z.object({ raw: z.unknown() }),
        request: {
          query: PRODUCT_RECOMMENDATIONS_QUERY,
          variables: { ids: '${args.ids}' },
        },
        response: { raw: '${response}' },
      },
      get_shop_information: {
        type: 'read',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        output: z.object({ raw: z.unknown() }),
        request: { query: SHOP_INFORMATION_QUERY },
        response: { raw: '${response}' },
      },
      search_store_content: {
        type: 'read',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        input: z.object({
          query: z.string(),
          first: z.number().int().min(1).max(20),
          after: z.string().optional(),
        }),
        output: z.object({ raw: z.unknown() }),
        request: {
          query: STORE_CONTENT_SEARCH_QUERY,
          variables: {
            query: '${args.query}',
            first: '${args.first}',
            after: '${args.after}',
          },
        },
        response: { raw: '${response}' },
      },
      create_cart: {
        type: 'action',
        method: 'POST',
        path: SHOPIFY_API_PATH,
        input: z.object({
          lines: z.array(cartLineSchema).min(1).max(50),
          note: z.string().max(500).optional(),
        }),
        output: z.object({ raw: z.unknown() }),
        request: {
          query: CART_CREATE_MUTATION,
          variables: {
            input: {
              lines: '${args.lines}',
              note: '${args.note}',
            },
          },
        },
        response: { raw: '${response}' },
      },
    },
  });

const responseNormalizer = connector('shopify_response_normalizer')
  .version('1.0.0')
  .compute('products', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: normalizedProductSearchOutput,
    run: normalizeProductSearchOperation,
  })
  .compute('checkout', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: checkoutOutput,
    run: normalizeCheckoutOperation,
  })
  .compute('recommendations', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: normalizedRecommendationsOutput,
    run: normalizeProductRecommendationsOperation,
  })
  .compute('product', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: productDetailOutput.omit({ storeOrigin: true }),
    run: normalizeProductDetailOperation,
  })
  .compute('shop', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: normalizedShopInformationOutput,
    run: normalizeShopInformationOperation,
  })
  .compute('content', {
    type: 'read',
    input: z.object({ raw: z.unknown() }),
    output: normalizedStoreContentSearchOutput,
    run: normalizeStoreContentSearchOperation,
  })
  .compute('store_answer', {
    type: 'read',
    input: z.object({ text: z.unknown() }),
    output: normalizedStoreAnswerOutput,
    run: normalizeStoreAnswerOperation,
  })
  .compute('store_knowledge', {
    type: 'read',
    input: z.object({
      source: z.enum(['store_information', 'policy', 'answer', 'published_guides']),
      policy: policyKindSchema.optional(),
      storeInformation: normalizedShopInformationOutput.optional(),
      policyStore: normalizedShopInformationOutput.optional(),
      faq: normalizedStoreAnswerOutput.optional(),
      published: normalizedStoreContentSearchOutput.optional(),
      fallback: normalizedStoreContentSearchOutput.optional(),
    }),
    output: normalizedStoreKnowledgeOutput,
    run: normalizeStoreKnowledgeOperation,
  });

const readShopify = annotations.readOnly({ openWorld: true });
const createShopifyCheckout = annotations.openAction({ destructive: false, confirm: true });
const widgetPolicy = {
  domain: SHOPIFY_WIDGET_DOMAIN,
  csp: {
    connectDomains: [],
    resourceDomains: ['https://cdn.shopify.com'],
    frameDomains: [],
  },
} as const;

const storeAnswerOutput = normalizedStoreKnowledgeOutput.extend({
  query: z.string(),
  storeOrigin: z.string(),
});

const searchProducts = tool('search_products', {
  title: 'Search Shopify products',
  description:
    'Search the merchant’s live Shopify catalog with Shopify natural-language relevance and last-token partial-prefix matching. Preserve the shopper’s concepts and concrete nouns in the query; express price, availability, and result-count constraints in their structured fields. Use PRICE with reverse false/true for cheapest/most-expensive ranking and HIDE for in-stock recommendations. Returns authoritative products, sale prices, variant completeness, availability, filters, and a cursor.',
  annotations: readShopify,
  input: z.object({
    query: z.string().max(500).default(''),
    first: z.number().int().min(1).max(20).default(12),
    after: z.string().max(2_000).optional(),
    sortKey: z.enum(['RELEVANCE', 'PRICE']).default('RELEVANCE'),
    reverse: z.boolean().default(false),
    unavailableProducts: z.enum(['HIDE', 'LAST', 'SHOW']).default('HIDE'),
  }),
  output: productSearchOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.search_products({
      query: input.query,
      first: input.first,
      after: input.after,
      sortKey: input.sortKey,
      reverse: input.reverse,
      unavailableProducts: input.unavailableProducts,
    });
    const result = connectors.normalize.products({ raw: upstream.raw });
    return {
      status: result.status,
      query: input.query,
      sortKey: input.sortKey,
      reverse: input.reverse,
      unavailableProducts: input.unavailableProducts,
      products: result.products,
      pageInfo: result.pageInfo,
      totalCount: result.totalCount,
      filters: result.filters,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
});

const showProductRecommendations = tool('show_product_recommendations', {
  title: 'Show final Shopify recommendations',
  description:
    'After all search, pagination, ranking, and finalist verification are complete, render exactly one final recommendation view from one to three authoritative Shopify product IDs. Call exactly once per shopper request and never use it for intermediate search pages. After rendering, the only assistant text allowed is exactly “Select Details to focus on one item.”',
  annotations: readShopify,
  input: z.object({ productIds: z.array(z.string()).min(1).max(3) }),
  output: recommendationsOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.get_recommendations({ ids: input.productIds });
    const result = connectors.normalize.recommendations({ raw: upstream.raw });
    return {
      status: result.status,
      products: result.products,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
  viewTitle: 'Shopify results',
  viewDescription:
    'At most three compact product recommendations with price, availability, one evidence line, and a detail action.',
  invoking: 'Finding the strongest matches…',
  invoked: 'Shopify results ready',
  view: {
    component: 'product-recommendations',
    entry: './views/product-recommendations.tsx',
  },
  ...widgetPolicy,
});

const getProduct = tool('get_product', {
  title: 'Get Shopify product details',
  description:
    'Get authoritative details for one live Shopify product handle, including description, brand, type, tags, images, variants, prices, and availability.',
  annotations: readShopify,
  input: z.object({ handle: z.string().min(1).max(255) }),
  output: productDetailOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.get_product({ handle: input.handle });
    const result = connectors.normalize.product({ raw: upstream.raw });
    return {
      status: result.status,
      product: result.product,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
});

const showProduct = tool('show_product', {
  title: 'Show one Shopify product',
  description:
    'Render one named or shopper-selected Shopify product after its handle is known. Use this presentation tool instead of get_product only when the shopper should see the focused detail view. After rendering, the only assistant text allowed is exactly “Choose this item when you’re ready to review checkout.”',
  annotations: readShopify,
  input: z.object({ handle: z.string().min(1).max(255) }),
  output: productDetailOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.get_product({ handle: input.handle });
    const result = connectors.normalize.product({ raw: upstream.raw });
    return {
      status: result.status,
      product: result.product,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
  viewTitle: 'Shopify product details',
  viewDescription:
    'One selected product with live price, availability, options, and an explicit progressive checkout handoff.',
  invoking: 'Loading product details…',
  invoked: 'Product details ready',
  view: {
    component: 'product-detail',
    entry: './views/product-detail.tsx',
  },
  ...widgetPolicy,
});

const askStore = tool('ask_store', {
  title: 'Ask this Shopify store',
  description:
    'Answer every merchant-specific knowledge question through one deterministic path. Use source store_information for the shop profile and shipping countries. Use source policy plus the exact policy kind for contact, privacy, refund/returns, shipping, or terms. Use source answer for an ordinary FAQ or service question: the server checks Shopify’s live Storefront MCP FAQ answer first and searches published pages and articles only after not_found. Use source published_guides for an explicit page, article, or guide search. Preserve the returned canonical-policy, FAQ, or published-content source boundary and say when the store has not published an answer.',
  annotations: readShopify,
  input: z.object({
    query: z.string().min(1).max(500),
    context: z.string().max(2_000).optional(),
    source: z.enum(['store_information', 'policy', 'answer', 'published_guides']),
    policy: policyKindSchema.optional(),
  }),
  output: storeAnswerOutput,
  fulfil: ({ input, connectors }) => {
    const informationUpstream = when(input.source.equals('store_information'), () =>
      connectors.shopify.get_shop_information(),
    );
    const storeInformation = when(input.source.equals('store_information'), () =>
      connectors.normalize.shop({ raw: informationUpstream.raw }),
    );
    const policyUpstream = when(input.source.equals('policy'), () =>
      connectors.shopify.get_shop_information(),
    );
    const policyStore = when(input.source.equals('policy'), () =>
      connectors.normalize.shop({ raw: policyUpstream.raw }),
    );
    const faqUpstream = when(input.source.equals('answer'), () =>
      connectors.shopify_mcp.search_shop_policies_and_faqs({
        query: input.query,
        context: input.context,
      }),
    );
    const faq = when(input.source.equals('answer'), () =>
      connectors.normalize.store_answer({ text: faqUpstream.text }),
    );
    const publishedUpstream = when(input.source.equals('published_guides'), () =>
      connectors.shopify.search_store_content({ query: input.query, first: 10 }),
    );
    const published = when(input.source.equals('published_guides'), () =>
      connectors.normalize.content({ raw: publishedUpstream.raw }),
    );
    const fallbackUpstream = when(faq.status.equals('not_found'), () =>
      connectors.shopify.search_store_content({ query: input.query, first: 10 }),
    );
    const fallback = when(faq.status.equals('not_found'), () =>
      connectors.normalize.content({ raw: fallbackUpstream.raw }),
    );
    const result = connectors.normalize.store_knowledge({
      source: input.source,
      policy: input.policy,
      storeInformation: storeInformation.optional(),
      policyStore: policyStore.optional(),
      faq: faq.optional(),
      published: published.optional(),
      fallback: fallback.optional(),
    });
    return {
      status: result.status,
      source: result.source,
      query: input.query,
      shop: result.shop,
      policies: result.policies,
      answer: result.answer,
      items: result.items,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
  viewTitle: 'Answer from this store',
  viewDescription:
    'A compact, source-bounded answer added by Noodle to Shopify’s otherwise headless MCP tool.',
  invoking: 'Checking this store…',
  invoked: 'Store answer ready',
  view: {
    component: 'store-answer',
    entry: './views/store-answer.tsx',
  },
  ...widgetPolicy,
});

const getStoreInformation = tool('get_store_information', {
  title: 'Get store information and policies',
  description:
    'Answer questions from the Shopify store’s live name, description, primary domain, shipping countries, contact information, and published privacy, refund, shipping, and terms policies. Say when information is not published.',
  annotations: readShopify,
  input: z.object({}),
  output: shopInformationOutput,
  fulfil: ({ connectors }) => {
    const upstream = connectors.shopify.get_shop_information();
    const result = connectors.normalize.shop({ raw: upstream.raw });
    return {
      status: result.status,
      shop: result.shop,
      policies: result.policies,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
});

const searchPublishedGuides = tool('search_published_guides', {
  title: 'Search published store guides',
  description:
    'Search the merchant’s live Shopify pages and blog articles only when the shopper explicitly requests published pages, articles, guides, sizing, care, brand, contact, or other broader written material. Use get_store_information first for canonical policies. Never call this tool for a natural-language FAQ or merchant-specific service question; call ask_store instead. Returns bounded plain-text evidence, source URLs, dates, and a pagination cursor; say when nothing relevant is published.',
  annotations: readShopify,
  input: z.object({
    query: z.string().min(1).max(500),
    first: z.number().int().min(1).max(20).default(10),
    after: z.string().max(2_000).optional(),
  }),
  output: storeContentSearchOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.search_store_content({
      query: input.query,
      first: input.first,
      after: input.after,
    });
    const result = connectors.normalize.content({ raw: upstream.raw });
    return {
      status: result.status,
      query: input.query,
      items: result.items,
      pageInfo: result.pageInfo,
      totalCount: result.totalCount,
      errors: result.errors,
      storeOrigin: SHOPIFY_STORE_ORIGIN,
    };
  },
});

const createCheckout = tool('create_checkout', {
  title: 'Continue to Shopify checkout',
  visibility: ['app'],
  description:
    'After the buyer explicitly continues, create one new Shopify cart from the widget-local lines. Shopify revalidates merchandise, stock, and totals and returns the exact allowlisted checkout URL.',
  annotations: createShopifyCheckout,
  input: z.object({
    lines: z.array(cartLineSchema).min(1).max(50),
    note: z.string().max(500).optional(),
  }),
  output: checkoutOutput,
  fulfil: ({ input, connectors }) => {
    const upstream = connectors.shopify.create_cart({ lines: input.lines, note: input.note });
    const result = connectors.normalize.checkout({ raw: upstream.raw });
    return {
      status: result.status,
      checkoutUrl: result.checkoutUrl,
      subtotal: result.subtotal,
      total: result.total,
      errors: result.errors,
      warnings: result.warnings,
    };
  },
});

export default server(
  'shopify_storefront',
  {
    title: 'Noodle Seed for Shopify',
    version: '1.0.0',
    use: {
      shopify: shopifyStorefront,
      shopify_mcp: shopifyStorefrontMcp,
      normalize: responseNormalizer,
    },
    agentGuide: SHOPIFY_AGENT_GUIDE,
    branding: {
      name: 'Noodle Seed for Shopify',
      accent: '#008060',
      surface: '#F6FBF8',
      surfaceDark: '#0F1713',
      radius: 'lg',
      density: 'comfortable',
    },
    instructions: SHOPIFY_SERVER_INSTRUCTIONS,
    handoff: { allowedDomains: [SHOPIFY_STORE_ORIGIN] },
    assistant: embeddedAssistant({
      model: noodleManaged(),
      access: publicWebsite({
        origins: [SHOPIFY_STORE_ORIGIN],
        capabilities: [
          searchProducts,
          showProductRecommendations,
          getProduct,
          showProduct,
          askStore,
          createCheckout,
        ],
        instructions: SHOPIFY_ASSISTANT_INSTRUCTIONS,
      }),
      layout: { mode: 'floating', position: 'bottom-right', panelWidth: 420 },
      labels: {
        welcomeHeading: 'How can I help you shop?',
        composerPlaceholder: 'Search products or ask about the store…',
      },
      presentation: {
        panel: { surface: 'glass', elevation: 'soft', border: 'subtle' },
        launcher: { icon: 'brand-mark', status: 'session', effect: 'pulse' },
        header: {
          mark: 'status',
          badge: { text: 'Live catalog', tone: 'success', indicator: true },
        },
        composer: { leadingIcon: 'brand-mark', shape: 'pill' },
      },
      suggestedPrompts: [
        'Show me the three lowest-priced products currently in stock',
        'Show me products that are currently on sale',
        'What is your shipping policy?',
        'Search your guides and FAQs for care instructions',
      ],
    }),
  },
  [
    searchProducts,
    showProductRecommendations,
    getProduct,
    showProduct,
    askStore,
    getStoreInformation,
    searchPublishedGuides,
    createCheckout,
  ],
);
