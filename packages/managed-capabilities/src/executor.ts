import { z } from 'zod';
import type { CapabilityBudget } from './budget.js';
import {
  type WebCapability,
  type WebExtractResult,
  type WebPolicy,
  webExtractRequestSchema,
  webExtractResultSchema,
  webPolicySchema,
} from './contracts.js';
import { CapabilityError } from './errors.js';
import { WEB_EXTRACT_LIMITS as limits } from './limits.js';
import { publicPageUrl } from './urls.js';

export interface PublicPageReaderPort {
  read(request: {
    readonly url: string;
    readonly domains?: readonly string[];
    readonly signal: AbortSignal;
    readonly beforeRequest: () => void;
    readonly maxBytes: number;
  }): Promise<unknown>;
}
export interface WebExtractDeps {
  readonly reader: PublicPageReaderPort;
  readonly budget: CapabilityBudget;
  readonly enabled: boolean;
  /** Computed from verified caller claims and the underlying declaration, never from tool arguments. */
  readonly authorized: boolean;
  readonly operatorPolicy: WebPolicy;
  readonly signal?: AbortSignal;
  /** Durable, attributable admission. A refusal or outage must not dispatch the reader. */
  readonly admit: () => Promise<boolean>;
}

const pageSchema = z
  .object({
    url: z.string().max(limits.maxUrlCharacters),
    title: z.string().max(512),
    text: z.string().min(1).max(limits.maxPageBytes),
    retrievedAt: z.iso.datetime(),
    links: z
      .array(
        z
          .object({
            url: z.string().max(limits.maxUrlCharacters),
            label: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(limits.maxLinks),
  })
  .strict();

export function effectiveWebPolicy(developer: WebPolicy = {}, operator: WebPolicy = {}): WebPolicy {
  const a = webPolicySchema.parse(developer);
  const b = webPolicySchema.parse(operator);
  const domains = intersectDomains(a.domains, b.domains);
  return {
    maxUrls: Math.min(a.maxUrls ?? limits.maxUrls, b.maxUrls ?? limits.maxUrls),
    maxCalls: Math.min(a.maxCalls ?? limits.maxCalls, b.maxCalls ?? limits.maxCalls),
    timeoutMs: Math.min(a.timeoutMs ?? limits.timeoutMs, b.timeoutMs ?? limits.timeoutMs),
    maxTextBytes: Math.min(
      a.maxTextBytes ?? limits.maxTextBytes,
      b.maxTextBytes ?? limits.maxTextBytes,
    ),
    ...(domains === undefined ? {} : { domains }),
  };
}

function intersectDomains(a?: readonly string[], b?: readonly string[]): string[] | undefined {
  return a === undefined
    ? b === undefined
      ? undefined
      : [...b]
    : b === undefined
      ? [...a]
      : a.filter((host) => b.includes(host));
}

/** One governed path for generated MCP tools, assistant calls and composed operations. */
export async function executeWebExtract(
  declaration: WebCapability,
  input: unknown,
  deps: WebExtractDeps,
): Promise<WebExtractResult> {
  if (!deps.enabled) throw new CapabilityError('capability_unavailable');
  if (!deps.authorized) throw new CapabilityError('capability_policy_denied');
  if (deps.signal?.aborted) throw new CapabilityError('capability_cancelled');
  const request = webExtractRequestSchema.safeParse(input);
  if (!request.success) throw new CapabilityError('capability_source_rejected');
  const policy = effectiveWebPolicy(declaration.policy, deps.operatorPolicy);
  const domains = intersectDomains(policy.domains, request.data.domains);
  if (request.data.urls.length > (policy.maxUrls ?? limits.maxUrls))
    throw new CapabilityError('capability_policy_denied');
  const urls = request.data.urls.map((url) => publicPageUrl(url, domains).href);
  if (new Set(urls).size !== urls.length) throw new CapabilityError('capability_source_rejected');
  const deadline = deps.budget.reserve(urls, policy);
  const signal = deps.signal === undefined ? deadline : AbortSignal.any([deadline, deps.signal]);
  let admitted: boolean;
  try {
    admitted = await withinSignal(signal, deps.admit);
  } catch {
    if (signal.aborted)
      throw new CapabilityError(
        deps.signal?.aborted ? 'capability_cancelled' : 'capability_budget_exhausted',
      );
    throw new CapabilityError('capability_unavailable');
  }
  if (!admitted) throw new CapabilityError('capability_budget_exhausted');
  const parts = await Promise.all(
    urls.map(async (url, requestIndex) => {
      try {
        return await deps.budget.withSlot(signal, async () => {
          const raw = await withinSignal(signal, () =>
            deps.reader.read({
              url,
              signal,
              maxBytes: limits.maxPageBytes,
              beforeRequest: () => {
                signal.throwIfAborted();
                deps.budget.beforeRequest();
              },
              ...(domains === undefined ? {} : { domains }),
            }),
          );
          const parsed = pageSchema.safeParse(raw);
          if (!parsed.success) throw new CapabilityError('capability_result_invalid');
          const page = parsed.data;
          const sourceUrl = publicPageUrl(page.url, domains);
          for (const link of page.links) {
            if (publicPageUrl(link.url, domains).origin !== sourceUrl.origin)
              throw new CapabilityError('capability_result_invalid');
          }
          const content = deps.budget.text(page.text, policy.maxTextBytes ?? limits.maxTextBytes);
          const ref = `source_${requestIndex + 1}`;
          return {
            item: {
              requestIndex,
              sourceRef: ref,
              content: { format: 'text' as const, text: content.text },
              links: page.links,
              truncated: content.truncated,
            },
            source: {
              ref,
              url: sourceUrl.href,
              retrievedAt: page.retrievedAt,
              ...(page.title === '' ? {} : { title: page.title }),
            },
            warnings: content.truncated
              ? [{ requestIndex, code: 'content_truncated' as const }]
              : [],
          };
        });
      } catch (error) {
        const code = error instanceof CapabilityError ? error.code : 'capability_provider_failed';
        return { warnings: [{ requestIndex, code }] };
      }
    }),
  );
  if (signal.aborted)
    throw new CapabilityError(
      deps.signal?.aborted ? 'capability_cancelled' : 'capability_budget_exhausted',
    );
  const items = parts.flatMap((part) => ('item' in part ? [part.item] : []));
  const sources = parts.flatMap((part) => ('source' in part ? [part.source] : []));
  const warnings = parts.flatMap<WebExtractResult['warnings'][number]>((part) => part.warnings);
  if (items.length === 0) throw new CapabilityError('capability_provider_failed');
  const result = webExtractResultSchema.safeParse({
    status: warnings.length === 0 ? 'complete' : 'partial',
    items,
    sources,
    warnings,
  });
  if (!result.success) throw new CapabilityError('capability_result_invalid');
  return result.data;
}

/** A late/misbehaving adapter cannot hold the caller past cancellation or the trusted deadline. */
function withinSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
