/**
 * Deterministic result fusion (ADR 0202): equal-weight reciprocal rank fusion with k = 60,
 * canonical-URL then stable-ID dedupe, deterministic source-kind/stable-ID tie-break, and
 * policy filtering applied before the requested limit.
 */
import type { SearchHit } from './hits.js';
import type { SitePolicy } from './ir.js';
import { RRF_K } from './limits.js';

/** Exact origin/path admission for site hits — everything else is dropped, not returned. */
export function siteHitAllowed(policy: SitePolicy, hit: SearchHit): boolean {
  if (hit.sourceKind !== 'site' || hit.uri === undefined) return false;
  let parsed: URL;
  try {
    parsed = new URL(hit.uri);
  } catch {
    return false;
  }
  if (parsed.origin !== policy.origin) return false;
  return policy.include.some((glob) => pathMatches(parsed.pathname, glob));
}

/**
 * Glob matching over URL paths. Supports `**` (any segments) and `*` (within one segment),
 * with an exact literal as the degenerate case. A pattern with a trailing `/**` admits
 * everything beneath the prefix but not the bare prefix itself unless listed — so the site
 * root is admitted only by the glob `/`, and a whole site including it is `['/', '/**']`.
 */
export function pathMatches(pathname: string, glob: string): boolean {
  const pathSegments = pathname.split('/').filter((segment) => segment !== '');
  const globSegments = glob.split('/').filter((segment) => segment !== '');
  if (globSegments.length === 0) return pathSegments.length === 0;

  function match(pathIndex: number, globIndex: number): boolean {
    if (globIndex === globSegments.length) return pathIndex === pathSegments.length;
    const pattern = globSegments[globIndex];
    if (pattern === undefined) return false;
    if (pattern === '**') {
      // `**` consumes zero or more segments; a *trailing* `**` must consume at least one,
      // so `/docs/**` admits everything beneath `/docs` but not the bare prefix.
      const minimum = globIndex === globSegments.length - 1 ? 1 : 0;
      for (let skip = pathSegments.length - pathIndex; skip >= minimum; skip -= 1) {
        if (match(pathIndex + skip, globIndex + 1)) return true;
      }
      return false;
    }
    if (pathIndex === pathSegments.length) return false;
    const segment = pathSegments[pathIndex];
    if (segment === undefined || !segmentMatches(segment, pattern)) return false;
    return match(pathIndex + 1, globIndex + 1);
  }

  return match(0, 0);
}

function segmentMatches(segment: string, pattern: string): boolean {
  const firstStar = pattern.indexOf('*');
  if (firstStar === -1) return segment === pattern;
  const lastStar = pattern.lastIndexOf('*');
  const prefix = pattern.slice(0, firstStar);
  const suffix = pattern.slice(lastStar + 1);
  if (!segment.startsWith(prefix) || !segment.endsWith(suffix)) return false;
  if (segment.length < prefix.length + suffix.length) return false;
  const available = segment.length - suffix.length;
  let cursor = prefix.length;
  for (const middle of pattern.slice(firstStar + 1, lastStar).split('*')) {
    if (middle === '') continue;
    const found = segment.indexOf(middle, cursor);
    if (found === -1 || found + middle.length > available) return false;
    cursor = found + middle.length;
  }
  return true;
}

export interface FuseOptions {
  readonly limit: number;
  /** Every site policy of the knowledge component; a site hit must satisfy at least one. */
  readonly sitePolicies: readonly SitePolicy[];
}

/**
 * Fuse document and site result lists. Both inputs are ranked best-first and may be longer
 * than `limit`; providers' own scores are ignored — rank position is the only signal that
 * crosses a provider boundary.
 */
export function fuseHits(
  documents: readonly SearchHit[],
  sites: readonly SearchHit[],
  options: FuseOptions,
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  const admit = (hit: SearchHit, rank: number, weight: number) => {
    if (
      hit.sourceKind === 'site' &&
      !options.sitePolicies.some((policy) => siteHitAllowed(policy, hit))
    ) {
      return;
    }
    const key = hit.uri ?? hit.id;
    const contribution = weight / (RRF_K + rank + 1);
    const existing = scores.get(key);
    if (existing === undefined) {
      scores.set(key, { hit, score: contribution });
      return;
    }
    existing.score += contribution;
    // Canonical-URL then stable-ID dedupe keeps the earliest-seen hit; document evidence
    // outranks site evidence on collision because it is the versioned source.
    if (existing.hit.sourceKind === 'site' && hit.sourceKind === 'document') {
      existing.hit = hit;
    }
  };

  documents.forEach((hit, rank) => {
    admit(hit, rank, 1);
  });
  sites.forEach((hit, rank) => {
    admit(hit, rank, 1);
  });

  return [...scores.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.hit.sourceKind !== b.hit.sourceKind) {
        return a.hit.sourceKind === 'document' ? -1 : 1;
      }
      return a.hit.id.localeCompare(b.hit.id);
    })
    .slice(0, options.limit)
    .map((entry) => entry.hit);
}
