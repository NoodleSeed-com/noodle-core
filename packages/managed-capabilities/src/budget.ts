import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WebPolicy } from './contracts.js';
import { CapabilityError } from './errors.js';
import { WEB_EXTRACT_LIMITS as limits } from './limits.js';

const snapshotSchema = z
  .object({
    startedAt: z.number().int().nonnegative().nullable(),
    timeout: z.number().int().min(100).max(limits.timeoutMs),
    maxCalls: z.number().int().min(1).max(limits.maxCalls),
    maxUrls: z.number().int().min(1).max(limits.maxUrls),
    calls: z.number().int().min(0).max(limits.maxCalls),
    attempts: z.number().int().min(0).max(limits.maxHttpAttempts),
    bytes: z.number().int().min(0).max(limits.maxTurnTextBytes),
    urls: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(limits.maxUrls),
  })
  .strict();
export type CapabilityBudgetSnapshot = z.infer<typeof snapshotSchema>;
const urlKey = (url: string) => createHash('sha256').update(url).digest('hex');

/** Trusted turn/invocation state. Never reconstructed from client arguments or stored in an artifact. */
export class CapabilityBudget {
  #startedAt: number | undefined;
  #timeout: number = limits.timeoutMs;
  #maxCalls: number = limits.maxCalls;
  #maxUrls: number = limits.maxUrls;
  #calls = 0;
  #attempts = 0;
  #bytes = 0;
  #active = 0;
  readonly #urls = new Set<string>();
  readonly #waiters = new Set<() => void>();
  constructor(snapshot?: CapabilityBudgetSnapshot) {
    if (snapshot === undefined) return;
    const parsed = snapshotSchema.parse(snapshot);
    this.#startedAt = parsed.startedAt ?? undefined;
    this.#timeout = parsed.timeout;
    this.#maxCalls = parsed.maxCalls;
    this.#maxUrls = parsed.maxUrls;
    this.#calls = parsed.calls;
    this.#attempts = parsed.attempts;
    this.#bytes = parsed.bytes;
    for (const key of parsed.urls) this.#urls.add(key);
  }
  /** Only for server-held continuations; no source URLs or content are retained. */
  snapshot(): CapabilityBudgetSnapshot {
    return {
      startedAt: this.#startedAt ?? null,
      timeout: this.#timeout,
      maxCalls: this.#maxCalls,
      maxUrls: this.#maxUrls,
      calls: this.#calls,
      attempts: this.#attempts,
      bytes: this.#bytes,
      urls: [...this.#urls],
    };
  }

  reserve(urls: readonly string[], policy: WebPolicy): AbortSignal {
    this.#startedAt ??= Date.now();
    this.#timeout = Math.min(this.#timeout, policy.timeoutMs ?? limits.timeoutMs);
    this.#maxCalls = Math.min(this.#maxCalls, policy.maxCalls ?? limits.maxCalls);
    this.#maxUrls = Math.min(this.#maxUrls, policy.maxUrls ?? limits.maxUrls);
    const next = new Set([...this.#urls, ...urls.map(urlKey)]);
    if (this.#calls >= this.#maxCalls || next.size > this.#maxUrls) this.#exhausted();
    this.#checkTime();
    this.#calls += 1;
    for (const url of urls) this.#urls.add(urlKey(url));
    return AbortSignal.timeout(Math.max(1, this.#startedAt + this.#timeout - Date.now()));
  }

  beforeRequest(): void {
    this.#checkTime();
    if (this.#attempts >= limits.maxHttpAttempts) this.#exhausted();
    this.#attempts += 1;
  }

  text(value: string, maxBytes: number): { text: string; truncated: boolean } {
    const bytes = Buffer.from(value, 'utf8');
    let length = Math.min(bytes.length, maxBytes, limits.maxTurnTextBytes - this.#bytes);
    // Drop any incomplete final code point rather than introducing a replacement character.
    if (length < bytes.length)
      while (length > 0 && ((bytes[length] ?? 0) & 0xc0) === 0x80) length -= 1;
    if (length === 0) this.#exhausted();
    this.#bytes += length;
    return { text: bytes.subarray(0, length).toString('utf8'), truncated: length < bytes.length };
  }

  async withSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    while (this.#active >= limits.maxConcurrency) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.#waiters.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        this.#waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
        if (signal.aborted) wake();
      });
    }
    signal.throwIfAborted();
    this.#checkTime();
    this.#active += 1;
    try {
      return await run();
    } finally {
      this.#active -= 1;
      for (const wake of [...this.#waiters]) wake();
    }
  }

  #checkTime(): void {
    if (this.#startedAt !== undefined && Date.now() >= this.#startedAt + this.#timeout)
      this.#exhausted();
  }
  #exhausted(): never {
    throw new CapabilityError('capability_budget_exhausted');
  }
}
