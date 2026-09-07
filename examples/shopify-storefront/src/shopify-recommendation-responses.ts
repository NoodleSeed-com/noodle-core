import type { Money, ProductVariant, StorefrontProduct } from './shopify-responses.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

export type NormalizedProductRecommendationsResult = {
  readonly status: 'ok' | 'error';
  readonly products: readonly StorefrontProduct[];
  readonly errors: readonly string[];
};

export type ProductRecommendationsResult = NormalizedProductRecommendationsResult & {
  readonly storeOrigin: string;
};

export function normalizeProductRecommendationsOperation(input: {
  readonly raw: unknown;
}): NormalizedProductRecommendationsResult {
  function asRecordLocal(value: unknown): UnknownRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as UnknownRecord)
      : undefined;
  }
  function asStringLocal(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  function errorMessagesLocal(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        const item = asRecordLocal(entry);
        const message = asStringLocal(item?.message);
        if (!message) return undefined;
        const code = asStringLocal(item?.code);
        return code ? `${code}: ${message}` : message;
      })
      .filter((message): message is string => message !== undefined)
      .slice(0, 20);
  }
  function moneyLocal(value: unknown): Money | undefined {
    const item = asRecordLocal(value);
    const amount = asStringLocal(item?.amount);
    const currencyCode = asStringLocal(item?.currencyCode);
    return amount && currencyCode ? { amount, currencyCode } : undefined;
  }
  function selectedOptionLocal(
    value: unknown,
  ): ProductVariant['selectedOptions'][number] | undefined {
    const item = asRecordLocal(value);
    const name = asStringLocal(item?.name);
    const optionValue = asStringLocal(item?.value);
    return name && optionValue ? { name, value: optionValue } : undefined;
  }
  function variantLocal(value: unknown): ProductVariant | undefined {
    const item = asRecordLocal(value);
    const id = asStringLocal(item?.id);
    const title = asStringLocal(item?.title);
    const price = moneyLocal(item?.price);
    const compareAtPrice = item?.compareAtPrice == null ? null : moneyLocal(item.compareAtPrice);
    if (!id || !title || !price || typeof item?.availableForSale !== 'boolean') return undefined;
    if (compareAtPrice === undefined) return undefined;
    const options = Array.isArray(item.selectedOptions)
      ? item.selectedOptions
          .map(selectedOptionLocal)
          .filter((option): option is NonNullable<typeof option> => option !== undefined)
          .slice(0, 20)
      : [];
    return {
      id,
      title,
      availableForSale: item.availableForSale,
      price,
      compareAtPrice,
      selectedOptions: options,
    };
  }
  function productLocal(value: unknown): StorefrontProduct | undefined {
    const item = asRecordLocal(value);
    if (item?.__typename !== 'Product') return undefined;
    const id = asStringLocal(item.id);
    const handle = asStringLocal(item.handle);
    const title = asStringLocal(item.title);
    const priceRange = asRecordLocal(item.priceRange);
    const minimumPrice = moneyLocal(priceRange?.minVariantPrice);
    const maximumPrice = moneyLocal(priceRange?.maxVariantPrice);
    const variants = asRecordLocal(item.variants);
    const variantValues = variants?.nodes;
    if (
      !id ||
      !handle ||
      !title ||
      !minimumPrice ||
      !maximumPrice ||
      typeof item.availableForSale !== 'boolean' ||
      !Array.isArray(variantValues)
    ) {
      return undefined;
    }
    const normalizedVariants = variantValues
      .map(variantLocal)
      .filter((entry): entry is ProductVariant => entry !== undefined)
      .slice(0, 20);
    if (normalizedVariants.length !== variantValues.length) return undefined;
    const variantCountValue = asRecordLocal(item.variantsCount)?.count;
    const variantCount =
      typeof variantCountValue === 'number' && Number.isSafeInteger(variantCountValue)
        ? variantCountValue
        : normalizedVariants.length;
    const image = asRecordLocal(item.featuredImage);
    const imageUrl = asStringLocal(image?.url);
    return {
      id,
      handle,
      title,
      description: typeof item.description === 'string' ? item.description : '',
      availableForSale: item.availableForSale,
      featuredImage: imageUrl
        ? { url: imageUrl, altText: typeof image?.altText === 'string' ? image.altText : null }
        : null,
      minimumPrice,
      maximumPrice,
      variantCount,
      variantsComplete:
        asRecordLocal(variants?.pageInfo)?.hasNextPage !== true &&
        variantCount <= normalizedVariants.length,
      vendor: typeof item.vendor === 'string' ? item.vendor : '',
      productType: typeof item.productType === 'string' ? item.productType : '',
      tags: Array.isArray(item.tags)
        ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50)
        : [],
      onlineStoreUrl: typeof item.onlineStoreUrl === 'string' ? item.onlineStoreUrl : null,
      variants: normalizedVariants,
    };
  }

  const root = asRecordLocal(input.raw);
  const errors = errorMessagesLocal(root?.errors);
  if (errors.length > 0) return { status: 'error', products: [], errors };
  const nodes = asRecordLocal(root?.data)?.nodes;
  if (!Array.isArray(nodes)) {
    return {
      status: 'error',
      products: [],
      errors: ['Shopify returned an incomplete recommendation response.'],
    };
  }
  const liveNodes = nodes.filter((node) => node !== null);
  const products = liveNodes
    .map(productLocal)
    .filter((entry): entry is StorefrontProduct => entry !== undefined)
    .slice(0, 3);
  if (products.length !== liveNodes.length) {
    return {
      status: 'error',
      products: [],
      errors: ['Shopify returned malformed recommendation data.'],
    };
  }
  return { status: 'ok', products, errors: [] };
}

export function normalizeProductRecommendationsResponse(
  raw: unknown,
): NormalizedProductRecommendationsResult {
  return normalizeProductRecommendationsOperation({ raw });
}
