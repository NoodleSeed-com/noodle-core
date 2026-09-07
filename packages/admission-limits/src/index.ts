/**
 * Public-surface admission: the non-bypassable safety envelope (ADR 0201 §7) and the durable daily
 * counters that enforce its per-surface budget.
 *
 * Solvency before fairness. A per-surface daily cap bounds what a bot can spend of the customer's model
 * budget and needs no client-IP attribution to do it; per-source limits govern fairness between callers
 * and arrive once trusted ingress metadata is verified. Losing the latter degrades fairness, never
 * solvency — which is why the cap, not the rate limit, is the tier that ships first.
 */

export * from './client-address.js';
export * from './counter-store.js';
export * from './envelope.js';
export * from './in-memory-counter-store.js';
export * from './postgres-counter-store.js';
export * from './visitor-bucket.js';
