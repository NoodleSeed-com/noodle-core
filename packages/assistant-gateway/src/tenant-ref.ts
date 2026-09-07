/**
 * The tenant coordinate an assistant session is bound to.
 *
 * Structurally re-declared rather than imported: `packages/service`'s `store.ts` remains the canonical
 * definition, but the gateway must not depend on the hosted service (the dependency runs the other way).
 * The two shapes are identical by contract — widen them together.
 */
export interface TenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}
