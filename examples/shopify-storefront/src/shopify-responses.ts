type UnknownRecord = Readonly<Record<string, unknown>>;

export type Money = {
  readonly amount: string;
  readonly currencyCode: string;
};

export type ProductVariant = {
  readonly id: string;
  readonly title: string;
  readonly availableForSale: boolean;
  readonly price: Money;
  readonly compareAtPrice: Money | null;
  readonly selectedOptions: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
};

export type StorefrontProduct = {
  readonly id: string;
  readonly handle: string;
  readonly title: string;
  readonly description: string;
  readonly availableForSale: boolean;
  readonly featuredImage: { readonly url: string; readonly altText: string | null } | null;
  readonly minimumPrice: Money;
  readonly maximumPrice: Money;
  readonly variantCount: number;
  readonly variantsComplete: boolean;
  readonly variants: readonly ProductVariant[];
  readonly vendor: string;
  readonly productType: string;
  readonly tags: readonly string[];
  readonly onlineStoreUrl: string | null;
};

export type ProductFilter = {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly values: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly input: string;
  }[];
};

export type NormalizedProductSearchResult = {
  readonly status: 'ok' | 'error';
  readonly products: readonly StorefrontProduct[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly totalCount: number;
  readonly filters: readonly ProductFilter[];
  readonly errors: readonly string[];
};

export type ProductSearchResult = NormalizedProductSearchResult & {
  readonly query: string;
  readonly sortKey: 'RELEVANCE' | 'PRICE';
  readonly reverse: boolean;
  readonly unavailableProducts: 'HIDE' | 'LAST' | 'SHOW';
  readonly storeOrigin: string;
};

export type CheckoutResult = {
  readonly status: 'ready' | 'error';
  readonly checkoutUrl: string | null;
  readonly subtotal: Money | null;
  readonly total: Money | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
};

export type ProductDetailResult = {
  readonly status: 'ok' | 'not_found' | 'error';
  readonly product:
    | (StorefrontProduct & {
        readonly images: readonly { readonly url: string; readonly altText: string | null }[];
      })
    | null;
  readonly errors: readonly string[];
};

export type ShopInformationResult = {
  readonly status: 'ok' | 'error';
  readonly shop: {
    readonly name: string;
    readonly description: string;
    readonly primaryDomain: string;
    readonly shipsToCountries: readonly string[];
  } | null;
  readonly policies: readonly {
    readonly kind: 'contact' | 'privacy' | 'refund' | 'shipping' | 'terms';
    readonly title: string;
    readonly body: string;
    readonly url: string;
  }[];
  readonly errors: readonly string[];
};

export function normalizeProductSearchOperation(input: {
  readonly raw: unknown;
}): NormalizedProductSearchResult {
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
    const id = asStringLocal(item?.id);
    const handle = asStringLocal(item?.handle);
    const title = asStringLocal(item?.title);
    const priceRange = asRecordLocal(item?.priceRange);
    const minimumPrice = moneyLocal(priceRange?.minVariantPrice);
    const maximumPrice = moneyLocal(priceRange?.maxVariantPrice);
    const variants = asRecordLocal(item?.variants);
    const variantsValue = variants?.nodes;
    if (
      !id ||
      !handle ||
      !title ||
      !minimumPrice ||
      !maximumPrice ||
      typeof item?.availableForSale !== 'boolean' ||
      !Array.isArray(variantsValue)
    )
      return undefined;
    const normalizedVariants = variantsValue
      .map(variantLocal)
      .filter((entry): entry is ProductVariant => entry !== undefined)
      .slice(0, 100);
    const variantCountValue = asRecordLocal(item?.variantsCount)?.count;
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
  function filterValueLocal(value: unknown): ProductFilter['values'][number] | undefined {
    const item = asRecordLocal(value);
    const id = asStringLocal(item?.id);
    const label = asStringLocal(item?.label);
    const rawInput =
      typeof item?.input === 'string' ? item.input : JSON.stringify(item?.input ?? {});
    return id && label && typeof item?.count === 'number' && Number.isSafeInteger(item.count)
      ? { id, label, count: item.count, input: rawInput }
      : undefined;
  }
  function productFilterLocal(value: unknown): ProductFilter | undefined {
    const item = asRecordLocal(value);
    const id = asStringLocal(item?.id);
    const label = asStringLocal(item?.label);
    const type = asStringLocal(item?.type);
    if (!id || !label || !type || !Array.isArray(item?.values)) return undefined;
    const values = item.values
      .map(filterValueLocal)
      .filter((entry): entry is ProductFilter['values'][number] => entry !== undefined)
      .slice(0, 50);
    if (values.length !== item.values.length) return undefined;
    return { id, label, type, values };
  }

  const emptyPageInfo = { hasNextPage: false, endCursor: null } as const;
  const root = asRecordLocal(input.raw);
  const errors = errorMessagesLocal(root?.errors);
  if (errors.length > 0) {
    return {
      status: 'error',
      products: [],
      pageInfo: emptyPageInfo,
      totalCount: 0,
      filters: [],
      errors,
    };
  }

  const products = asRecordLocal(asRecordLocal(root?.data)?.search);
  if (!products || !Array.isArray(products.nodes)) {
    return {
      status: 'error',
      products: [],
      pageInfo: emptyPageInfo,
      totalCount: 0,
      filters: [],
      errors: ['Shopify returned an incomplete product search response.'],
    };
  }

  const pageInfo = asRecordLocal(products.pageInfo);
  const normalizedProducts = products.nodes
    .map(productLocal)
    .filter((entry): entry is StorefrontProduct => entry !== undefined)
    .slice(0, 20);
  const normalizedPageInfo = {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null,
  };
  const filterValues = Array.isArray(products.productFilters) ? products.productFilters : [];
  const filters = filterValues
    .map(productFilterLocal)
    .filter((entry): entry is ProductFilter => entry !== undefined)
    .slice(0, 20);
  if (
    normalizedProducts.length !== products.nodes.length ||
    filters.length !== filterValues.length
  ) {
    return {
      status: 'error',
      products: [],
      pageInfo: normalizedPageInfo,
      totalCount: 0,
      filters: [],
      errors: ['Shopify returned malformed product data.'],
    };
  }
  return {
    status: 'ok',
    products: normalizedProducts,
    pageInfo: normalizedPageInfo,
    totalCount:
      typeof products.totalCount === 'number' && Number.isSafeInteger(products.totalCount)
        ? products.totalCount
        : normalizedProducts.length,
    filters,
    errors: [],
  };
}

export function normalizeProductSearchResponse(raw: unknown): NormalizedProductSearchResult {
  return normalizeProductSearchOperation({ raw });
}

export function normalizeProductDetailOperation(input: {
  readonly raw: unknown;
}): ProductDetailResult {
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
    const id = asStringLocal(item?.id);
    const handle = asStringLocal(item?.handle);
    const title = asStringLocal(item?.title);
    const priceRange = asRecordLocal(item?.priceRange);
    const minimumPrice = moneyLocal(priceRange?.minVariantPrice);
    const maximumPrice = moneyLocal(priceRange?.maxVariantPrice);
    const variants = asRecordLocal(item?.variants);
    const variantsValue = variants?.nodes;
    if (
      !id ||
      !handle ||
      !title ||
      !minimumPrice ||
      !maximumPrice ||
      typeof item?.availableForSale !== 'boolean' ||
      !Array.isArray(variantsValue)
    )
      return undefined;
    const normalizedVariants = variantsValue
      .map(variantLocal)
      .filter((entry): entry is ProductVariant => entry !== undefined)
      .slice(0, 100);
    const variantCountValue = asRecordLocal(item?.variantsCount)?.count;
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
  if (errors.length > 0) return { status: 'error', product: null, errors };
  const value = asRecordLocal(asRecordLocal(root?.data)?.product);
  if (value === undefined) return { status: 'not_found', product: null, errors: [] };
  const normalized = productLocal(value);
  const imageValues = asRecordLocal(value.images)?.nodes;
  if (!normalized || !Array.isArray(imageValues)) {
    return { status: 'error', product: null, errors: ['Shopify returned malformed product data.'] };
  }
  const images = imageValues
    .map((entry) => {
      const image = asRecordLocal(entry);
      const url = asStringLocal(image?.url);
      return url
        ? { url, altText: typeof image?.altText === 'string' ? image.altText : null }
        : undefined;
    })
    .filter(
      (entry): entry is { readonly url: string; readonly altText: string | null } =>
        entry !== undefined,
    )
    .slice(0, 12);
  if (images.length !== imageValues.length) {
    return {
      status: 'error',
      product: null,
      errors: ['Shopify returned malformed product images.'],
    };
  }
  return { status: 'ok', product: { ...normalized, images }, errors: [] };
}

export function normalizeProductDetailResponse(raw: unknown): ProductDetailResult {
  return normalizeProductDetailOperation({ raw });
}

export function normalizeShopInformationOperation(input: {
  readonly raw: unknown;
}): ShopInformationResult {
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
  function plainTextLocal(html: string): string {
    const entities: Readonly<Record<string, string>> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' ',
      '&ndash;': '–',
      '&mdash;': '—',
    };
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(amp|lt|gt|quot|#39|nbsp|ndash|mdash);/g, (entity) => entities[entity] ?? entity)
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  const policyKinds = [
    ['contact', 'contactInformation'],
    ['privacy', 'privacyPolicy'],
    ['refund', 'refundPolicy'],
    ['shipping', 'shippingPolicy'],
    ['terms', 'termsOfService'],
  ] as const;
  const root = asRecordLocal(input.raw);
  const errors = errorMessagesLocal(root?.errors);
  if (errors.length > 0) return { status: 'error', shop: null, policies: [], errors };
  const shop = asRecordLocal(asRecordLocal(root?.data)?.shop);
  const name = asStringLocal(shop?.name);
  const primaryDomain = asStringLocal(asRecordLocal(shop?.primaryDomain)?.url);
  if (!shop || !name || !primaryDomain) {
    return {
      status: 'error',
      shop: null,
      policies: [],
      errors: ['Shopify returned incomplete store information.'],
    };
  }
  const policies = policyKinds.flatMap(([kind, field]) => {
    const policy = asRecordLocal(shop[field]);
    if (!policy) return [];
    const title = asStringLocal(policy.title);
    const url = asStringLocal(policy.url);
    if (!title || !url || typeof policy.body !== 'string') return [];
    return [{ kind, title, body: plainTextLocal(policy.body).slice(0, 4_000), url }];
  });
  return {
    status: 'ok',
    shop: {
      name,
      description: typeof shop.description === 'string' ? shop.description.slice(0, 2_000) : '',
      primaryDomain,
      shipsToCountries: Array.isArray(shop.shipsToCountries)
        ? shop.shipsToCountries
            .filter((country): country is string => typeof country === 'string')
            .slice(0, 250)
        : [],
    },
    policies,
    errors: [],
  };
}

export function normalizeShopInformationResponse(raw: unknown): ShopInformationResult {
  return normalizeShopInformationOperation({ raw });
}

export function normalizeCheckoutOperation(input: { readonly raw: unknown }): CheckoutResult {
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
  function checkoutErrorLocal(
    errors: readonly string[],
    warnings: readonly string[] = [],
  ): CheckoutResult {
    return {
      status: 'error',
      checkoutUrl: null,
      subtotal: null,
      total: null,
      errors: [...errors].slice(0, 20),
      warnings: [...warnings].slice(0, 20),
    };
  }

  const root = asRecordLocal(input.raw);
  const graphQlErrors = errorMessagesLocal(root?.errors);
  if (graphQlErrors.length > 0) return checkoutErrorLocal(graphQlErrors);

  const cartCreate = asRecordLocal(asRecordLocal(root?.data)?.cartCreate);
  if (!cartCreate) return checkoutErrorLocal(['Shopify returned an incomplete cart response.']);

  const warnings = errorMessagesLocal(cartCreate.warnings);
  const userErrors = errorMessagesLocal(cartCreate.userErrors);
  if (userErrors.length > 0) return checkoutErrorLocal(userErrors, warnings);

  const cart = asRecordLocal(cartCreate.cart);
  const checkoutUrl = asStringLocal(cart?.checkoutUrl);
  if (!checkoutUrl) return checkoutErrorLocal(['Shopify did not return a checkout URL.'], warnings);

  const cost = asRecordLocal(cart?.cost);
  return {
    status: 'ready',
    checkoutUrl,
    subtotal: moneyLocal(cost?.subtotalAmount) ?? null,
    total: moneyLocal(cost?.totalAmount) ?? null,
    errors: [],
    warnings,
  };
}

export function normalizeCheckoutResponse(raw: unknown): CheckoutResult {
  return normalizeCheckoutOperation({ raw });
}
