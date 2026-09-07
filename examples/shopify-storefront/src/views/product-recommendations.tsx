import { useState } from 'react';
import { useCallTool, useLayout, useToolInfo } from '../helpers.js';
import type { StorefrontProduct } from '../shopify-responses.js';
import { ProductDetailPanel } from './product-detail.js';
import {
  formatMoney,
  isDiscounted,
  isProductDetail,
  isProductRecommendations,
  type ProductDetailToolResult,
  structured,
} from './shopify-widget-model.js';
import './shopify-mini.css';

const MAX_VISIBLE_MATCHES = 3;

function RecommendationCard({
  product,
  onDetails,
  pending,
}: {
  readonly product: StorefrontProduct;
  readonly onDetails: () => void;
  readonly pending: boolean;
}) {
  const variant = product.variants.find((item) => item.availableForSale) ?? product.variants[0];
  return (
    <article className="recommendation-card" data-product-card>
      {product.featuredImage ? (
        <img src={product.featuredImage.url} alt={product.featuredImage.altText ?? product.title} />
      ) : (
        <div className="image-placeholder" aria-hidden="true">
          NS
        </div>
      )}
      <div className="recommendation-copy">
        <div className="recommendation-heading">
          <h3>{product.title}</h3>
          <span className={`stock-dot ${product.availableForSale ? 'available' : ''}`}>
            {product.availableForSale ? 'In stock' : 'Unavailable'}
          </span>
        </div>
        <div className="price-line">
          <strong>{formatMoney(variant?.price ?? product.minimumPrice)}</strong>
          {isDiscounted(variant) ? (
            <del>{formatMoney(variant?.compareAtPrice ?? product.maximumPrice)}</del>
          ) : null}
        </div>
        <p>
          {product.description || [product.vendor, product.productType].filter(Boolean).join(' · ')}
        </p>
      </div>
      <button className="details-action" type="button" disabled={pending} onClick={onDetails}>
        {pending ? 'Loading…' : 'Details'}
      </button>
    </article>
  );
}

export default function ProductRecommendations() {
  const { theme } = useLayout();
  const toolInfo = useToolInfo('show_product_recommendations');
  const getProduct = useCallTool('get_product');
  const [detail, setDetail] = useState<ProductDetailToolResult>();
  const [loadingHandle, setLoadingHandle] = useState('');
  const [message, setMessage] = useState('');
  const result = toolInfo.isError ? undefined : toolInfo.structuredContent;

  if (detail) return <ProductDetailPanel result={detail} />;
  if (!isProductRecommendations(result)) {
    return (
      <main className="shopify-mini mini-state" data-theme={theme}>
        <p>
          {toolInfo.isError ? 'Could not load product matches.' : 'Finding the strongest matches…'}
        </p>
      </main>
    );
  }

  const products = result.products.slice(0, MAX_VISIBLE_MATCHES);
  async function showDetails(product: StorefrontProduct) {
    setLoadingHandle(product.handle);
    setMessage('');
    const response = await getProduct.callTool({ handle: product.handle });
    const productResult = structured<unknown>(response);
    if (!isProductDetail(productResult)) {
      setMessage('Product details are unavailable right now.');
      setLoadingHandle('');
      return;
    }
    setDetail(productResult);
  }

  return (
    <main
      className="shopify-mini recommendation-list"
      data-theme={theme}
      data-llm={`Showing ${products.length} final Shopify product recommendations.`}
    >
      {products.length === 0 ? (
        <p className="empty-message">No matching products are currently published.</p>
      ) : (
        <div className="recommendation-items">
          {products.map((product) => (
            <RecommendationCard
              key={product.id}
              product={product}
              pending={loadingHandle === product.handle}
              onDetails={() => void showDetails(product)}
            />
          ))}
        </div>
      )}
      {message ? (
        <p className="error-message" role="alert">
          {message}
        </p>
      ) : null}
    </main>
  );
}
