export interface ShopifyCustomerBinding {
  readonly customer: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Four synthetic deployment bindings prove reuse without exposing prospective-customer details. */
export const SHOPIFY_CUSTOMER_BINDINGS: readonly ShopifyCustomerBinding[] = [
  ['customer-a', 'alpha-outdoors'],
  ['customer-b', 'bravo-home'],
  ['customer-c', 'charlie-beauty'],
  ['customer-d', 'delta-pets'],
].map(([customer, shop]) => {
  const origin = `https://${shop}.myshopify.com`;
  return {
    customer: customer as string,
    env: {
      SHOPIFY_STORE_ORIGIN: origin,
      SHOPIFY_STOREFRONT_MCP_ENDPOINT: `${origin}/api/mcp`,
    },
  };
});
