/**
 * Generation-friendly nearest-match suggestions for compile-time reference errors.
 *
 * Pure and dependency-free (node builtins only). The compiler attaches `didYouMean` / `suggestions`
 * (and a stable `docAnchor`) to resolution {@link CompileError}s so a *machine* manifest generator can
 * self-correct typos in connector aliases, operation names, and schema references without a human in
 * the loop. See GT-1 in docs/STATUS.md.
 */

/** Typo tolerance for a probe of the given length: 1 for short names, up to 3 for long ones. */
function typoThreshold(length: number): number {
  return Math.min(3, Math.max(1, Math.floor(length / 3)));
}

/**
 * Levenshtein edit distance between `a` and `b`, capped at `cap`: the true distance when it is
 * `<= cap`, otherwise `cap + 1`. Single rolling DP row with a per-row early exit, so probing many
 * far-apart candidates stays cheap. Indices stay within `[0, bl]` by construction; the `?? 0`
 * fallbacks below only satisfy `noUncheckedIndexedAccess` and are never reached.
 */
export function boundedDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > cap) return cap + 1;
  const row: number[] = [];
  for (let j = 0; j <= bl; j++) row.push(j);
  for (let i = 1; i <= al; i++) {
    let diag = i - 1; // row[0] before this row overwrites it = dp[i-1][0]
    row[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const up = row[j] ?? 0; // dp[i-1][j], before overwrite
      const left = row[j - 1] ?? 0; // dp[i][j-1], already updated this row
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(diag + cost, up + 1, left + 1);
      diag = up;
      row[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
  }
  const d = row[bl] ?? cap + 1;
  return d <= cap ? d : cap + 1;
}

/**
 * The closest candidate to `probe` within the typo threshold, or `undefined` if none is close enough.
 * Comparison is case-insensitive; ties break to the lexicographically smaller candidate (deterministic).
 */
export function nearestMatch(probe: string, candidates: readonly string[]): string | undefined {
  const p = probe.toLowerCase();
  const threshold = typoThreshold(probe.length);
  let best: string | undefined;
  let bestDistance = threshold + 1;
  for (const candidate of candidates) {
    const d = boundedDistance(p, candidate.toLowerCase(), threshold);
    if (d > threshold) continue;
    if (d < bestDistance || (d === bestDistance && (best === undefined || candidate < best))) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Up to `limit` candidates ranked by closeness to `probe` (closest first; ties lexicographic). Unlike
 * {@link nearestMatch} this is not gated by the typo threshold — it always offers the nearest few as a
 * candidate set a generator can choose from, even when nothing is a likely single correction.
 */
export function rankSuggestions(probe: string, candidates: readonly string[], limit = 3): string[] {
  const p = probe.toLowerCase();
  return candidates
    .map((candidate) => ({
      candidate,
      distance: boundedDistance(p, candidate.toLowerCase(), Math.max(p.length, candidate.length)),
    }))
    .sort(
      (x, y) =>
        x.distance - y.distance ||
        (x.candidate < y.candidate ? -1 : x.candidate > y.candidate ? 1 : 0),
    )
    .slice(0, limit)
    .map((scored) => scored.candidate);
}

/** Optional, generation-friendly fields the compiler attaches to a resolution error. */
export interface SuggestionFields {
  readonly didYouMean?: string;
  readonly suggestions?: readonly string[];
  readonly docAnchor: string;
}

/** Explicit documentation routes for product-guide and App Package diagnostics. */
export const COMPILE_ERROR_DOC_ANCHORS: Readonly<Record<string, string>> = {
  agent_guide_invalid: 'compile-errors#agent-guide-invalid',
  agent_guide_duplicate_workflow: 'compile-errors#agent-guide-duplicate-workflow',
  agent_guide_duplicate_example: 'compile-errors#agent-guide-duplicate-example',
  agent_guide_example_workflow_missing: 'compile-errors#agent-guide-example-workflow-missing',
  agent_guide_capability_missing: 'compile-errors#agent-guide-capability-missing',
  agent_guide_capability_kind: 'compile-errors#agent-guide-capability-kind',
  app_package_sensitive_content: 'compile-errors#app-package-sensitive-content',
};

/** A stable, machine-readable docs anchor for an error code (e.g. `compile-errors#unknown-operation`). */
export function docAnchorFor(code: string): string {
  return Object.hasOwn(COMPILE_ERROR_DOC_ANCHORS, code)
    ? (COMPILE_ERROR_DOC_ANCHORS[code] ?? `compile-errors#${code.replace(/_/g, '-')}`)
    : `compile-errors#${code.replace(/_/g, '-')}`;
}

/**
 * Build the `didYouMean` / `suggestions` / `docAnchor` fields for a reference error against the set of
 * known identifiers in scope. Omits `didYouMean`/`suggestions` when there is nothing to offer (e.g. no
 * candidates declared), but always carries a stable `docAnchor`.
 */
export function suggestionFields(
  code: string,
  probe: string,
  candidates: readonly string[],
): SuggestionFields {
  const didYouMean = nearestMatch(probe, candidates);
  const suggestions = rankSuggestions(probe, candidates);
  return {
    ...(didYouMean !== undefined ? { didYouMean } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    docAnchor: docAnchorFor(code),
  };
}
