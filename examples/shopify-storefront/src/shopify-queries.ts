export const PRODUCT_SEARCH_QUERY = `
  query SearchProducts(
    $query: String!
    $first: Int!
    $after: String
    $sortKey: SearchSortKeys!
    $reverse: Boolean!
    $unavailableProducts: SearchUnavailableProductsType!
  ) {
    search(
      query: $query
      first: $first
      after: $after
      types: [PRODUCT]
      prefix: LAST
      sortKey: $sortKey
      reverse: $reverse
      unavailableProducts: $unavailableProducts
    ) {
      nodes {
        __typename
        ... on Product {
          id handle title description availableForSale vendor productType tags onlineStoreUrl
          featuredImage { url altText }
          priceRange {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variantsCount { count precision }
          variants(first: 20) {
            nodes {
              id title availableForSale
              price { amount currencyCode }
              compareAtPrice { amount currencyCode }
              selectedOptions { name value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      totalCount
      productFilters { id label type values { id label count input } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const PRODUCT_DETAIL_QUERY = `
  query ProductDetail($handle: String!) {
    product(handle: $handle) {
      id handle title description availableForSale vendor productType tags onlineStoreUrl
      featuredImage { url altText }
      priceRange {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      variantsCount { count precision }
      images(first: 12) { nodes { url altText } }
      variants(first: 100) {
        nodes {
          id title availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const PRODUCT_RECOMMENDATIONS_QUERY = `
  query ProductRecommendations($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id handle title description availableForSale vendor productType tags onlineStoreUrl
        featuredImage { url altText }
        priceRange {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variantsCount { count precision }
        variants(first: 20) {
          nodes {
            id title availableForSale
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            selectedOptions { name value }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const STORE_CONTENT_SEARCH_QUERY = `
  query SearchStoreContent($query: String!, $first: Int!, $after: String) {
    search(query: $query, first: $first, after: $after, types: [PAGE, ARTICLE], prefix: LAST) {
      nodes {
        __typename
        ... on Page { id handle title body onlineStoreUrl updatedAt }
        ... on Article {
          id handle title content(truncateAt: 4000) onlineStoreUrl publishedAt tags
          blog { title }
        }
      }
      totalCount
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const SHOP_INFORMATION_QUERY = `
  query ShopInformation {
    shop {
      name description
      primaryDomain { url }
      shipsToCountries
      contactInformation { title body url }
      privacyPolicy { title body url }
      refundPolicy { title body url }
      shippingPolicy { title body url }
      termsOfService { title body url }
    }
  }
`;

export const CART_CREATE_MUTATION = `
  mutation CreateCheckout($input: CartInput!) {
    cartCreate(input: $input) {
      cart {
        checkoutUrl
        cost {
          subtotalAmount { amount currencyCode }
          totalAmount { amount currencyCode }
        }
      }
      userErrors { code field message }
      warnings { code message target }
    }
  }
`;
