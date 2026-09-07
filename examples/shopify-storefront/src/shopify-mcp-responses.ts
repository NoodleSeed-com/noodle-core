import type { StoreContentItem, StoreContentSearchResult } from './shopify-content-responses.js';
import type { ShopInformationResult } from './shopify-responses.js';

export type StoreKnowledgeRequestSource =
  | 'store_information'
  | 'policy'
  | 'answer'
  | 'published_guides';
export type StorePolicyKind = 'contact' | 'privacy' | 'refund' | 'shipping' | 'terms';

export interface StoreAnswerResult {
  readonly status: 'ok' | 'not_found' | 'error';
  readonly answer: string;
  readonly errors: readonly string[];
}

export interface StoreKnowledgeResult {
  readonly status: 'ok' | 'not_found' | 'error';
  readonly source: 'store_information' | 'canonical_policy' | 'faq' | 'published_content' | 'none';
  readonly shop: ShopInformationResult['shop'];
  readonly policies: ShopInformationResult['policies'];
  readonly answer: string;
  readonly items: readonly StoreContentItem[];
  readonly errors: readonly string[];
}

/** Bounded, deterministic normalization for Shopify's text-only Storefront MCP answer. */
export function normalizeStoreAnswerOperation(input: {
  readonly text?: unknown;
}): StoreAnswerResult {
  if (typeof input.text !== 'string') {
    return { status: 'error', answer: '', errors: ['Shopify returned an invalid store answer.'] };
  }
  const answer = input.text.trim().slice(0, 12_000);
  if (answer.length === 0 || answer === '[]' || answer === '{}' || answer === 'null') {
    return { status: 'not_found', answer: '', errors: [] };
  }
  return { status: 'ok', answer, errors: [] };
}

/** Select one bounded knowledge result after the recorded flow executes its declared source path. */
export function normalizeStoreKnowledgeOperation(input: {
  readonly source: StoreKnowledgeRequestSource;
  readonly policy?: StorePolicyKind;
  readonly storeInformation?: ShopInformationResult;
  readonly policyStore?: ShopInformationResult;
  readonly faq?: StoreAnswerResult;
  readonly published?: StoreContentSearchResult;
  readonly fallback?: StoreContentSearchResult;
}): StoreKnowledgeResult {
  const empty = {
    shop: null,
    policies: [],
    answer: '',
    items: [],
  } as const;
  const store = input.source === 'store_information' ? input.storeInformation : input.policyStore;
  if (input.source === 'store_information' || input.source === 'policy') {
    if (store?.status === 'error') {
      return {
        status: 'error',
        source: 'none',
        ...empty,
        errors: [...store.errors].slice(0, 20),
      };
    }
    if (!store) {
      return {
        status: 'error',
        source: 'none',
        ...empty,
        errors: ['The canonical Shopify knowledge route did not execute.'],
      };
    }
    if (input.source === 'store_information') {
      if (store.shop) {
        return {
          status: 'ok',
          source: 'store_information',
          shop: store.shop,
          policies: [],
          answer: '',
          items: [],
          errors: [],
        };
      }
      return { status: 'not_found', source: 'none', ...empty, errors: [] };
    }
    if (input.policy === undefined) {
      return {
        status: 'error',
        source: 'none',
        ...empty,
        errors: ['A canonical policy request requires one exact policy kind.'],
      };
    }
    const policy = store.policies.find((entry) => entry.kind === input.policy);
    if (policy) {
      return {
        status: 'ok',
        source: 'canonical_policy',
        shop: null,
        policies: [policy],
        answer: '',
        items: [],
        errors: [],
      };
    }
    return { status: 'not_found', source: 'none', ...empty, errors: [] };
  }

  const content = input.source === 'published_guides' ? input.published : input.fallback;
  if (input.source === 'answer' && input.faq?.status === 'ok') {
    return {
      status: 'ok',
      source: 'faq',
      shop: null,
      policies: [],
      answer: input.faq.answer,
      items: [],
      errors: [],
    };
  }
  if (content?.status === 'ok' && content.items.length > 0) {
    return {
      status: 'ok',
      source: 'published_content',
      shop: null,
      policies: [],
      answer: '',
      items: content.items.slice(0, 3),
      errors: [],
    };
  }
  const errors = [...(input.faq?.errors ?? []), ...(content?.errors ?? [])].slice(0, 20);
  if (errors.length > 0) {
    return { status: 'error', source: 'none', ...empty, errors };
  }
  return { status: 'not_found', source: 'none', ...empty, errors: [] };
}
