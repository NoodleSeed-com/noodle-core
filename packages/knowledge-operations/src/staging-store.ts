/**
 * Encrypted transient document staging (ADR 0202 D5): deploy uploads land here, sealed and
 * content-addressed by tenant + sha256, until the deploy transaction publishes them into a
 * revision. Entries are TTL-bounded — an upload that never publishes is swept, so plaintext
 * never persists outside the sealed revision store.
 */
/** How long staged bytes may wait for their deploy transaction before being swept. */
export const STAGING_TTL_MS = 60 * 60 * 1000;

export interface KnowledgeStagingStore {
  /** Store sealed bytes. Re-uploading the same tenant+hash is idempotent. */
  put(tenantKey: string, sha256: string, sealed: Buffer, bytes: number): Promise<void>;
  has(tenantKey: string, sha256: string): Promise<boolean>;
  /** Sealed bytes for a staged document, if present and unexpired. */
  get(tenantKey: string, sha256: string): Promise<Buffer | undefined>;
  /** Remove entries older than the TTL. Returns the removed count. */
  sweepExpired(): Promise<number>;
}

export class InMemoryKnowledgeStagingStore implements KnowledgeStagingStore {
  private readonly entries = new Map<string, { sealed: Buffer; stagedAt: number }>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async put(tenantKey: string, sha256: string, sealed: Buffer): Promise<void> {
    this.entries.set(this.key(tenantKey, sha256), { sealed, stagedAt: this.now().getTime() });
  }

  async has(tenantKey: string, sha256: string): Promise<boolean> {
    return (await this.get(tenantKey, sha256)) !== undefined;
  }

  async get(tenantKey: string, sha256: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(this.key(tenantKey, sha256));
    if (entry === undefined) return undefined;
    if (this.now().getTime() - entry.stagedAt > STAGING_TTL_MS) return undefined;
    return entry.sealed;
  }

  async sweepExpired(): Promise<number> {
    const cutoff = this.now().getTime() - STAGING_TTL_MS;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.stagedAt < cutoff) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private key(tenantKey: string, sha256: string): string {
    return `${tenantKey}#${sha256}`;
  }
}
