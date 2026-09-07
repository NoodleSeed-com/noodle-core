import type { ProductRecommendationsResult } from '../shopify-recommendation-responses.js';
import type {
  CheckoutResult,
  Money,
  ProductDetailResult,
  ProductVariant,
  StorefrontProduct,
} from '../shopify-responses.js';

export type ProductDetailToolResult = ProductDetailResult & { readonly storeOrigin: string };

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) && typeof value.amount === 'string' && typeof value.currencyCode === 'string'
  );
}

function isVariant(value: unknown): value is ProductVariant {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.availableForSale === 'boolean' &&
    isMoney(value.price) &&
    (value.compareAtPrice === null || isMoney(value.compareAtPrice)) &&
    Array.isArray(value.selectedOptions) &&
    value.selectedOptions.every(
      (option) =>
        isRecord(option) && typeof option.name === 'string' && typeof option.value === 'string',
    )
  );
}

export function isProduct(value: unknown): value is StorefrontProduct {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.handle === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.availableForSale === 'boolean' &&
    (value.featuredImage === null ||
      (isRecord(value.featuredImage) &&
        typeof value.featuredImage.url === 'string' &&
        (typeof value.featuredImage.altText === 'string' ||
          value.featuredImage.altText === null))) &&
    isMoney(value.minimumPrice) &&
    isMoney(value.maximumPrice) &&
    typeof value.variantCount === 'number' &&
    Number.isSafeInteger(value.variantCount) &&
    typeof value.variantsComplete === 'boolean' &&
    Array.isArray(value.variants) &&
    value.variants.every(isVariant) &&
    typeof value.vendor === 'string' &&
    typeof value.productType === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    (typeof value.onlineStoreUrl === 'string' || value.onlineStoreUrl === null)
  );
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

export function isProductRecommendations(value: unknown): value is ProductRecommendationsResult {
  return (
    isRecord(value) &&
    (value.status === 'ok' || value.status === 'error') &&
    typeof value.storeOrigin === 'string' &&
    isCanonicalHttpsOrigin(value.storeOrigin) &&
    Array.isArray(value.products) &&
    value.products.length <= 3 &&
    value.products.every(isProduct) &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === 'string')
  );
}

export function isProductDetail(value: unknown): value is ProductDetailToolResult {
  if (
    !isRecord(value) ||
    (value.status !== 'ok' && value.status !== 'not_found' && value.status !== 'error') ||
    typeof value.storeOrigin !== 'string' ||
    !isCanonicalHttpsOrigin(value.storeOrigin) ||
    !Array.isArray(value.errors) ||
    !value.errors.every((error) => typeof error === 'string')
  ) {
    return false;
  }
  if (value.product === null) return value.status !== 'ok';
  return (
    isProduct(value.product) &&
    Array.isArray((value.product as Readonly<Record<string, unknown>>).images) &&
    ((value.product as Readonly<Record<string, unknown>>).images as readonly unknown[]).every(
      (image) =>
        isRecord(image) &&
        typeof image.url === 'string' &&
        (typeof image.altText === 'string' || image.altText === null),
    )
  );
}

export function isCheckout(value: unknown): value is CheckoutResult {
  return (
    isRecord(value) &&
    (value.status === 'ready' || value.status === 'error') &&
    (typeof value.checkoutUrl === 'string' || value.checkoutUrl === null) &&
    (value.subtotal === null || isMoney(value.subtotal)) &&
    (value.total === null || isMoney(value.total)) &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === 'string') &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string')
  );
}

export function structured<T>(value: unknown): T | undefined {
  return isRecord(value) ? (value.structuredContent as T | undefined) : undefined;
}

export function formatMoney(value: Money): string {
  const amount = Number(value.amount);
  if (!Number.isFinite(amount)) return `${value.amount} ${value.currencyCode}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: value.currencyCode,
    }).format(amount);
  } catch {
    return `${value.amount} ${value.currencyCode}`;
  }
}

export function isDiscounted(variant: ProductVariant | undefined): boolean {
  if (
    !variant?.compareAtPrice ||
    variant.compareAtPrice.currencyCode !== variant.price.currencyCode
  ) {
    return false;
  }
  return Number(variant.compareAtPrice.amount) > Number(variant.price.amount);
}

export function safeStoreUrl(value: string, storeOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === storeOrigin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
