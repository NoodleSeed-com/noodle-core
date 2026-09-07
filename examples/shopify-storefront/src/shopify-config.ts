import { variable } from '@noodleseed/one';

/** One exact HTTPS storefront origin, supplied per deployed merchant environment. */
export const SHOPIFY_STORE_ORIGIN = variable('SHOPIFY_STORE_ORIGIN');
/** The same merchant's standard Shopify Storefront MCP endpoint (`<origin>/api/mcp`). */
export const SHOPIFY_STOREFRONT_MCP_ENDPOINT = variable('SHOPIFY_STOREFRONT_MCP_ENDPOINT');
export const SHOPIFY_STOREFRONT_API_VERSION = '2026-07';
