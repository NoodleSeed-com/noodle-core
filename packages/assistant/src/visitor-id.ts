/**
 * A stable, non-secret identifier for this browser, used only so admission can be fair.
 *
 * The service bounds anonymous mints per source address. That is the right abuse bound and the wrong
 * fairness bound: a corporate NAT, a university, or a mobile carrier's CGNAT puts hundreds of
 * unrelated people behind one address, and they end up racing each other for one visitor's
 * allowance. This gives each browser its own, so the tenth person in an office does not see
 * "assistant is unavailable right now" because nine colleagues opened the assistant first.
 *
 * What it deliberately is not:
 *
 * - **Not a credential.** It grants nothing, and the service treats it as a bucket key it hashes on
 *   arrival. A visitor may clear it or forge a new one at any time; the address bound underneath is
 *   what stops abuse, and it is not rotatable.
 * - **Not the session token.** Nothing that authorizes a request is ever written to storage.
 * - **Not cross-site.** `localStorage` is per-origin, so this identifies a browser to one embedding
 *   site and cannot follow anyone anywhere else.
 *
 * Storage is best effort in every direction. Private modes, disabled site data, and sandboxed frames
 * all throw on access rather than returning empty, so every path returns `undefined` instead — the
 * visitor loses a fairness tier, never their conversation.
 */

/** Namespaced so it is obvious in an embedder's storage inspector whose key this is. */
const STORAGE_PREFIX = 'noodleseed.assistant.visitor.';

function randomVisitorId(): string | undefined {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return undefined;
  }
}

/**
 * The identifier for one assistant source, creating and persisting it on first use.
 *
 * Keyed by source so a page embedding two different assistants does not share one bucket between
 * them, and so repointing an element at a different embed starts a fresh one.
 */
export function visitorIdForSource(sourceKey: string): string | undefined {
  const key = `${STORAGE_PREFIX}${sourceKey}`;
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (typeof stored === 'string' && stored.length > 0) return stored;
  } catch {
    return undefined;
  }
  const created = randomVisitorId();
  if (created === undefined) return undefined;
  try {
    globalThis.localStorage?.setItem(key, created);
  } catch {
    // Unwritable storage still gets a fairness tier for the life of this page; it simply does not
    // survive a navigation. Better than dropping the visitor back onto the shared address bucket.
  }
  return created;
}
