import {
  ASSISTANT_CONTINUITY_MAX_RESTORES,
  ASSISTANT_CONTINUITY_RESTORE_CEILING,
  ASSISTANT_CONTINUITY_WINDOW_CEILING_MS,
  ASSISTANT_CONTINUITY_WINDOW_MS,
  continuityMaxRestores,
  continuityWindowMs,
} from './continuity-store.js';

/**
 * Resolving anonymous cross-page display continuity for one surface (ADR 0223, clause 15).
 *
 * Two parties describe the same capability and they are not peers. The developer declares it in
 * `server.ts` as part of the deployment; the operator tunes it for their own environment without a
 * deploy. The clamp between them runs one way — tighten, never widen — exactly as the admission
 * envelope's does ([ADR 0212](../../../docs/decisions/0212-reusable-developer-intent-and-operator-authority.md)).
 *
 * The asymmetry is sharpest on `enabled`. An operator may switch continuity **off**, because that is
 * their own surface and their visitors' text; they may not switch it **on**, because a surface whose
 * author never declared continuity is one whose author never reasoned about whether their pages should
 * carry conversation across a navigation.
 */

/** What a public or mixed surface declares in `server.ts`. Shapes match the manifest exactly. */
export interface AssistantContinuityDeclaration {
  readonly enabled?: boolean;
  readonly windowSeconds?: number;
  readonly maxRestores?: number;
}

/**
 * What an operator sets for their own environment. `enabled: false` disables; `true` is inert, since
 * an operator cannot enable a capability the deployment does not declare.
 */
export interface AssistantContinuityOverride {
  readonly enabled?: boolean;
  readonly windowSeconds?: number;
  readonly maxRestores?: number;
}

export interface ResolvedAssistantContinuity {
  readonly enabled: boolean;
  /** Zero whenever `enabled` is false, so a caller cannot read a live window off a dead surface. */
  readonly windowMs: number;
  readonly maxRestores: number;
}

const OFF: ResolvedAssistantContinuity = { enabled: false, windowMs: 0, maxRestores: 0 };

/**
 * A declared bound that is not a non-negative integer fails the surface closed rather than falling back
 * to the shipped default.
 *
 * This is deliberately the opposite of the spend ladder's malformed-allowance rule, which fails to
 * *absent* because an outage costs more than a day of unbudgeted spend. The thing configured here is a
 * capability, and the safe failure for a capability is not to exist: a typo that silently grants a
 * 300-second window nobody asked for is worse than a typo that grants nothing.
 */
function boundedInteger(value: number | undefined): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 ? value : 'invalid';
}

export function resolveContinuity(
  declaration: AssistantContinuityDeclaration | undefined,
  override: AssistantContinuityOverride | undefined,
): ResolvedAssistantContinuity {
  if (declaration?.enabled !== true) return OFF;
  if (override?.enabled === false) return OFF;

  const declaredWindow = boundedInteger(declaration.windowSeconds);
  const declaredRestores = boundedInteger(declaration.maxRestores);
  const overriddenWindow = boundedInteger(override?.windowSeconds);
  const overriddenRestores = boundedInteger(override?.maxRestores);
  if (
    declaredWindow === 'invalid' ||
    declaredRestores === 'invalid' ||
    overriddenWindow === 'invalid' ||
    overriddenRestores === 'invalid'
  ) {
    return OFF;
  }

  // Each side is clamped to the structural ceiling first, then the tighter of the two wins. Clamping
  // before the `Math.min` means an over-eager operator value degrades to the ceiling rather than
  // becoming one, which is the same shape `surfaceEnvelope` uses for daily budgets.
  const windowMs = Math.min(
    declaredWindow === undefined
      ? ASSISTANT_CONTINUITY_WINDOW_MS
      : continuityWindowMs(declaredWindow * 1000),
    overriddenWindow === undefined
      ? ASSISTANT_CONTINUITY_WINDOW_CEILING_MS
      : continuityWindowMs(overriddenWindow * 1000),
  );
  const maxRestores = Math.min(
    declaredRestores === undefined
      ? ASSISTANT_CONTINUITY_MAX_RESTORES
      : continuityMaxRestores(declaredRestores),
    overriddenRestores === undefined
      ? ASSISTANT_CONTINUITY_RESTORE_CEILING
      : continuityMaxRestores(overriddenRestores),
  );

  // Zero from either party is a real value and is the kill switch, so it must not read as "unset".
  // Collapsing it to `OFF` here keeps every caller from having to remember that a zero-length window
  // and a disabled surface are the same thing.
  if (windowMs === 0 || maxRestores === 0) return OFF;
  return { enabled: true, windowMs, maxRestores };
}
