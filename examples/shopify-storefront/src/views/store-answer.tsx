import { useLayout, useToolInfo } from '../helpers.js';
import { isRecord, structured } from './shopify-widget-model.js';
import './shopify-mini.css';

interface StoreAnswerResult {
  readonly status: 'ok' | 'not_found' | 'error';
  readonly source: 'store_information' | 'canonical_policy' | 'faq' | 'published_content' | 'none';
  readonly query: string;
  readonly shop: ShopInformation | null;
  readonly policies: readonly StorePolicy[];
  readonly answer: string;
  readonly items: readonly StoreContentItem[];
  readonly errors: readonly string[];
}

interface ShopInformation {
  readonly name: string;
  readonly description: string;
  readonly primaryDomain: string;
  readonly shipsToCountries: readonly string[];
}

interface StorePolicy {
  readonly kind: 'contact' | 'privacy' | 'refund' | 'shipping' | 'terms';
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

interface StoreContentItem {
  readonly kind: 'page' | 'article';
  readonly id: string;
  readonly handle: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly tags: readonly string[];
  readonly section: string | null;
}

function isStoreContentItem(value: unknown): value is StoreContentItem {
  return (
    isRecord(value) &&
    (value.kind === 'page' || value.kind === 'article') &&
    typeof value.id === 'string' &&
    typeof value.handle === 'string' &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    (value.url === null || typeof value.url === 'string') &&
    (value.publishedAt === null || typeof value.publishedAt === 'string') &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    (value.section === null || typeof value.section === 'string')
  );
}

function isShopInformation(value: unknown): value is ShopInformation {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.primaryDomain === 'string' &&
    Array.isArray(value.shipsToCountries) &&
    value.shipsToCountries.every((country) => typeof country === 'string')
  );
}

function isStorePolicy(value: unknown): value is StorePolicy {
  return (
    isRecord(value) &&
    (value.kind === 'contact' ||
      value.kind === 'privacy' ||
      value.kind === 'refund' ||
      value.kind === 'shipping' ||
      value.kind === 'terms') &&
    typeof value.title === 'string' &&
    typeof value.body === 'string' &&
    typeof value.url === 'string'
  );
}

function isStoreAnswer(value: unknown): value is StoreAnswerResult {
  return (
    isRecord(value) &&
    (value.status === 'ok' || value.status === 'not_found' || value.status === 'error') &&
    (value.source === 'store_information' ||
      value.source === 'canonical_policy' ||
      value.source === 'faq' ||
      value.source === 'published_content' ||
      value.source === 'none') &&
    typeof value.query === 'string' &&
    (value.shop === null || isShopInformation(value.shop)) &&
    Array.isArray(value.policies) &&
    value.policies.every(isStorePolicy) &&
    typeof value.answer === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isStoreContentItem) &&
    Array.isArray(value.errors) &&
    value.errors.every((error) => typeof error === 'string')
  );
}

export function StoreAnswerPanel({ result }: { readonly result: StoreAnswerResult }) {
  const { theme } = useLayout();
  const failed = result.status === 'error';
  const notFound = result.status === 'not_found';
  const published = result.source === 'published_content';
  const canonicalPolicy = result.source === 'canonical_policy' ? result.policies[0] : undefined;
  const storeInformation = result.source === 'store_information' ? result.shop : null;
  const copy = canonicalPolicy
    ? `${canonicalPolicy.title}: ${canonicalPolicy.body}`
    : storeInformation
      ? `${storeInformation.name}: ${storeInformation.description}`
      : published
        ? result.items.map((item) => `${item.title}: ${item.body}`).join('\n\n')
        : notFound
          ? 'This store has not published an answer to that question.'
          : failed
            ? (result.errors[0] ?? 'The store answer is temporarily unavailable.')
            : result.answer;
  const kicker = canonicalPolicy
    ? 'Published policy from this store'
    : storeInformation
      ? 'Store information'
      : published
        ? 'Published evidence from this store'
        : 'Answer from this store';
  return (
    <main className="shopify-mini store-answer" data-theme={theme} data-llm={copy}>
      <div className="mini-kicker">{kicker}</div>
      <h2>{result.query}</h2>
      {canonicalPolicy ? (
        <div className="store-answer-policy">
          <a href={canonicalPolicy.url} target="_blank" rel="noreferrer">
            {canonicalPolicy.title}
          </a>
          <p>{canonicalPolicy.body}</p>
        </div>
      ) : storeInformation ? (
        <div className="store-answer-policy">
          <a href={storeInformation.primaryDomain} target="_blank" rel="noreferrer">
            {storeInformation.name}
          </a>
          {storeInformation.description ? <p>{storeInformation.description}</p> : null}
          {storeInformation.shipsToCountries.length > 0 ? (
            <p>Ships to {storeInformation.shipsToCountries.join(', ')}.</p>
          ) : null}
        </div>
      ) : published ? (
        <ul className="store-answer-sources">
          {result.items.map((item) => (
            <li key={item.id}>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
              ) : (
                <strong>{item.title}</strong>
              )}
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className={failed ? 'error-message' : 'store-answer-copy'}>{copy}</p>
      )}
    </main>
  );
}

export default function StoreAnswer() {
  const result = structured<unknown>(useToolInfo());
  if (!isStoreAnswer(result)) {
    return (
      <main className="shopify-mini mini-state">
        <p>Store information is unavailable.</p>
      </main>
    );
  }
  return <StoreAnswerPanel result={result} />;
}
