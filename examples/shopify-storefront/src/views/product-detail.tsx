import { useState } from 'react';
import {
  useCallTool,
  useLayout,
  useOpenExternal,
  useToolInfo,
  useViewState,
  useWidgetReady,
} from '../helpers.js';
import type { ProductVariant } from '../shopify-responses.js';
import {
  formatMoney,
  isCheckout,
  isDiscounted,
  isProductDetail,
  type ProductDetailToolResult,
  safeStoreUrl,
  structured,
} from './shopify-widget-model.js';
import './shopify-mini.css';

type Stage = 'detail' | 'checkout';

function firstAvailableVariant(variants: readonly ProductVariant[]): ProductVariant | undefined {
  return variants.find((variant) => variant.availableForSale) ?? variants[0];
}

export function ProductDetailPanel({ result }: { readonly result: ProductDetailToolResult }) {
  const { theme } = useLayout();
  const ready = useWidgetReady();
  const openExternal = useOpenExternal();
  const checkout = useCallTool('create_checkout');
  const product = result.product;
  const initialVariant = product ? firstAvailableVariant(product.variants) : undefined;
  const [variantId, setVariantId] = useViewState(
    'shopify_selected_variant',
    initialVariant?.id ?? '',
  );
  const [quantity, setQuantity] = useViewState('shopify_quantity', 1);
  const [stage, setStage] = useState<Stage>('detail');
  const [message, setMessage] = useState('');

  if (result.status !== 'ok' || !product) {
    return (
      <main className="shopify-mini mini-state" data-theme={theme}>
        <p>
          {result.status === 'not_found'
            ? 'That product is no longer available.'
            : 'Product details are unavailable.'}
        </p>
      </main>
    );
  }

  const selectedVariant =
    product.variants.find((variant) => variant.id === variantId) ?? initialVariant;
  const storeUrl = product.onlineStoreUrl
    ? safeStoreUrl(product.onlineStoreUrl, result.storeOrigin)
    : undefined;
  const displayImage = product.images[0] ?? product.featuredImage;

  async function continueToShopify() {
    if (!selectedVariant) return;
    setMessage('');
    const response = await checkout.callTool({
      lines: [{ merchandiseId: selectedVariant.id, quantity }],
    });
    const checkoutResult = structured<unknown>(response);
    if (
      !isCheckout(checkoutResult) ||
      checkoutResult.status !== 'ready' ||
      !checkoutResult.checkoutUrl
    ) {
      const error = isCheckout(checkoutResult) ? checkoutResult.errors[0] : undefined;
      setMessage(error ?? 'Shopify checkout is unavailable right now.');
      return;
    }
    const checkoutUrl = safeStoreUrl(checkoutResult.checkoutUrl, result.storeOrigin);
    if (!checkoutUrl) {
      setMessage('Shopify returned an unexpected checkout destination.');
      return;
    }
    await openExternal(checkoutUrl);
  }

  return (
    <main
      className="shopify-mini detail-card"
      data-theme={theme}
      data-llm={`Selected product: ${product.title}. ${selectedVariant ? `Selected variant: ${selectedVariant.title}.` : ''}`}
    >
      <div className="detail-overview">
        {displayImage ? (
          <img src={displayImage.url} alt={displayImage.altText ?? product.title} />
        ) : (
          <div className="image-placeholder" aria-hidden="true">
            NS
          </div>
        )}
        <div className="detail-copy">
          <div className="mini-kicker">
            {product.vendor || product.productType || 'Product details'}
          </div>
          <h2>{product.title}</h2>
          <div className="price-line">
            <strong>{formatMoney(selectedVariant?.price ?? product.minimumPrice)}</strong>
            {isDiscounted(selectedVariant) ? (
              <del>{formatMoney(selectedVariant?.compareAtPrice ?? product.maximumPrice)}</del>
            ) : null}
          </div>
          <span className={`stock-label ${selectedVariant?.availableForSale ? 'available' : ''}`}>
            {selectedVariant?.availableForSale ? 'Available' : 'Unavailable'}
          </span>
        </div>
      </div>

      {stage === 'detail' ? (
        <>
          {product.description ? (
            <p className="product-description">{product.description}</p>
          ) : null}
          {product.variants.length > 1 ? (
            <label className="variant-field">
              <span>Option</span>
              <select
                value={selectedVariant?.id ?? ''}
                onChange={(event) => setVariantId(event.currentTarget.value)}
              >
                {product.variants.map((variant) => (
                  <option key={variant.id} value={variant.id} disabled={!variant.availableForSale}>
                    {variant.title} · {formatMoney(variant.price)}
                    {variant.availableForSale ? '' : ' · unavailable'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!product.variantsComplete ? (
            <p className="mini-note">More options may be available on the store.</p>
          ) : null}
          <div className="mini-actions">
            <button
              className="primary-action"
              type="button"
              disabled={!ready || !selectedVariant?.availableForSale}
              onClick={() => setStage('checkout')}
            >
              Choose this item
            </button>
            {storeUrl ? (
              <button
                className="secondary-action"
                type="button"
                onClick={() => void openExternal(storeUrl)}
              >
                View on store
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <section className="checkout-summary" aria-label="Checkout summary">
          <div className="summary-heading">
            <div>
              <div className="mini-kicker">Checkout summary</div>
              <strong>
                {quantity} × {product.title}
              </strong>
              <span>{selectedVariant?.title}</span>
            </div>
            <strong>
              {selectedVariant
                ? formatMoney({
                    ...selectedVariant.price,
                    amount: String(Number(selectedVariant.price.amount) * quantity),
                  })
                : ''}
            </strong>
          </div>
          <label className="quantity-field">
            <span>Quantity</span>
            <input
              type="number"
              min="1"
              max="10"
              value={quantity}
              onChange={(event) =>
                setQuantity(Math.max(1, Math.min(10, Number(event.currentTarget.value) || 1)))
              }
            />
          </label>
          <p className="mini-note">
            Shopify confirms stock, discounts, tax, shipping, and the final total.
          </p>
          {message ? (
            <p className="error-message" role="alert">
              {message}
            </p>
          ) : null}
          <div className="mini-actions">
            <button className="secondary-action" type="button" onClick={() => setStage('detail')}>
              Back
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={!ready || checkout.isPending}
              onClick={() => void continueToShopify()}
            >
              {checkout.isPending ? 'Preparing…' : 'Continue to Shopify'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

export default function ProductDetail() {
  const { theme } = useLayout();
  const toolInfo = useToolInfo('show_product');
  const value = toolInfo.isError ? undefined : toolInfo.structuredContent;

  if (!isProductDetail(value)) {
    return (
      <main className="shopify-mini mini-state" data-theme={theme}>
        <p>
          {toolInfo.isError || value !== undefined
            ? 'Product details are unavailable.'
            : 'Loading product details…'}
        </p>
      </main>
    );
  }
  return <ProductDetailPanel result={value} />;
}
