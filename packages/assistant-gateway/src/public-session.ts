import {
  type AdmissionEnvelope,
  type DailyCounterStore,
  visitorBucket,
} from '@noodle-borg/admission-limits/portable';
import { isPublicEmbedId, type PublicEmbedRecord, type PublicEmbedStore } from './embed-store.js';
import type { PublicSurface } from './public-surface.js';
import { type SurfaceBudgetBounds, surfaceEnvelope } from './surface-budget.js';

/**
 * Minting an anonymous session for a public page.
 *
 * Transport-free on purpose: the hosting service owns the HTTP adapter (parse body, map result), and
 * everything that decides *whether* a stranger gets a session lives here, behind narrow ports. That is
 * what keeps the decision testable without a server and the service-side residue to a few lines.
 *
 * The refusal order is part of the contract, not an implementation detail. ADR 0201 §8 requires
 * admission to complete before any metered work, so the store-durability and budget checks come before
 * anything that would read deployment state or reach a model.
 */

export interface PublicSessionPorts {
  readonly embeds: Pick<PublicEmbedStore, 'lookup'>;
  readonly counters: DailyCounterStore;
  /** The live surface for this tenant, read from the *active* deployment at mint time. */
  resolveActiveSurface(embed: PublicEmbedRecord): Promise<PublicSurface | undefined>;
  /** Optional hosted entitlement; absent preserves the ordinary customer-funded envelope. */
  readonly resolveBudgetBounds?: (
    embed: PublicEmbedRecord,
  ) => Promise<SurfaceBudgetBounds | undefined>;
  /** Persist the anonymous session and return its bearer token and expiry. */
  createSession(input: {
    readonly embed: PublicEmbedRecord;
    readonly origin: string;
    readonly subject: string;
    readonly envelope: AdmissionEnvelope;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;
  /** Opaque, deployment-scoped, unlinkable to any person. */
  newAnonymousSubject(): string;
  now(): Date;
}

export interface PublicSessionRequest {
  readonly embedId: unknown;
  readonly origin: unknown;
  /**
   * The visitor's address bucket (admission tier 3), already hashed by the transport — a raw address
   * must never reach this decision, a counter key, or an audit payload. Absent when ingress could not
   * be parsed, in which case the surface tier alone applies: fairness degrades, solvency does not.
   */
  readonly addressBucket?: string | undefined;
  /**
   * The browser's own visitor identifier (admission tier 4), unvalidated exactly like `embedId`:
   * it arrives from the request body, so the decision owns its parse rather than the transport.
   * Client-supplied and therefore rotatable, so it bounds fairness and never abuse — the address
   * tier underneath is the one that cannot be rotated.
   */
  readonly visitorId?: unknown;
}

export type PublicSessionResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
      readonly embed: PublicEmbedRecord;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /**
       * The surface this refusal belongs to, once it is known. Present for every refusal an operator
       * needs to see — out of budget, address at its ceiling, origin off the live allowlist — and
       * absent for the ones that cannot be attributed to a tenant at all, which are prober noise.
       */
      readonly embed?: PublicEmbedRecord;
    };

function refuse(
  status: number,
  code: string,
  message: string,
  embed?: PublicEmbedRecord,
): PublicSessionResult {
  return { ok: false, status, code, message, ...(embed === undefined ? {} : { embed }) };
}

export async function mintPublicSession(
  request: PublicSessionRequest,
  envelope: AdmissionEnvelope,
  ports: PublicSessionPorts,
): Promise<PublicSessionResult> {
  if (typeof request.embedId !== 'string' || !isPublicEmbedId(request.embedId)) {
    return refuse(400, 'invalid_embed_id', 'embedId is required');
  }
  if (typeof request.origin !== 'string' || request.origin.length === 0) {
    return refuse(403, 'origin_not_allowed', 'origin is not allowed');
  }

  // Before anything else that touches state: a budget that resets on restart and is unshared across
  // instances is indistinguishable from having no budget, so a non-durable store cannot serve the
  // public at all (ADR 0201 §7). Refusing here rather than at deploy keeps the failure loud and local.
  if (!ports.counters.durable) {
    return refuse(
      503,
      'admission_store_not_durable',
      'public sessions require a durable admission counter store',
    );
  }

  const embed = await ports.embeds.lookup(request.embedId);
  // 403, never 404: a wrong id must not tell a prober whether some other id exists.
  if (embed === undefined) return refuse(403, 'embed_not_found', 'embed is not available');

  const surface = await ports.resolveActiveSurface(embed);
  if (surface === undefined) {
    return refuse(409, 'surface_unavailable', 'assistant deployment is unavailable', embed);
  }
  // Origins come from the live artifact, so `noodle deploy` alone updates a pasted snippet.
  if (!surface.origins.includes(request.origin)) {
    return refuse(403, 'origin_not_allowed', 'origin is not allowed', embed);
  }

  // The surface's own budget, which an operator may have lowered — or set to zero, which is the kill
  // switch. Resolved after the embed is known and before anything is spent.
  const budgetBounds = await ports.resolveBudgetBounds?.(embed);
  const surfaceLimits = surfaceEnvelope(envelope, embed, budgetBounds);
  const now = ports.now();
  // Tier 4 before tier 3, which is before solvency. A visitor at their own hourly ceiling is refused
  // without spending any of the shared address allowance, so one person behind a corporate NAT cannot
  // consume the allowance the other three hundred are also using. An abuser who rotates the
  // identifier simply never meets this tier and lands on the address bound below, which is the point:
  // this is fairness, that is abuse control, and they are deliberately not the same limit.
  const visitor = visitorBucket(request.visitorId);
  if (visitor !== undefined) {
    const perVisitor = await ports.counters.consume(
      {
        key: `mints:vis:${embed.embedId}:${visitor}`,
        limit: surfaceLimits.mintsPerVisitorHour,
        window: 'hour',
      },
      now,
    );
    if (!perVisitor.allowed) {
      return refuse(
        429,
        'visitor_session_budget_exhausted',
        'assistant is unavailable right now',
        embed,
      );
    }
  }
  // Fairness before solvency: an address at its hourly ceiling is refused without spending any of the
  // surface's day, so one visitor cannot burn the customer's budget on refusals.
  if (typeof request.addressBucket === 'string') {
    const perAddress = await ports.counters.consume(
      {
        key: `mints:addr:${embed.embedId}:${request.addressBucket}`,
        limit: surfaceLimits.mintsPerAddressHour,
        window: 'hour',
      },
      now,
    );
    if (!perAddress.allowed) {
      return refuse(
        429,
        'address_session_budget_exhausted',
        'assistant is unavailable right now',
        embed,
      );
    }
  }
  const mints = await ports.counters.consume(
    { key: `mints:${embed.embedId}`, limit: surfaceLimits.mintsPerDay },
    now,
  );
  if (!mints.allowed) {
    // Distinct from a hard error: the widget renders this calmly, and an operator sees a surface that
    // is switched off (limit 0) or spent, not a broken embed.
    return refuse(
      429,
      'daily_session_budget_exhausted',
      'assistant is unavailable right now',
      embed,
    );
  }

  const session = await ports.createSession({
    embed,
    origin: request.origin,
    subject: ports.newAnonymousSubject(),
    envelope: surfaceLimits,
  });
  return { ok: true, token: session.token, expiresAt: session.expiresAt, embed };
}
