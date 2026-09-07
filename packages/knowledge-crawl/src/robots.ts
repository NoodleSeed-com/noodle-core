/**
 * Minimal robots.txt evaluation for the managed crawler: `*` user-agent groups only, with the
 * de-facto longest-match precedence between Allow and Disallow (Allow wins an exact-length tie),
 * plus global `Sitemap:` collection. Deliberately dependency-free; if richer semantics are ever
 * needed, verify the dependency license first (root rules).
 */

interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface Robots {
  isAllowed(path: string): boolean;
  readonly sitemaps: readonly string[];
}

export function parseRobots(text: string): Robots {
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  let inStarGroup = false;
  let groupHasAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one group; a rule line closes the agent list, so a
      // user-agent line after rules starts a fresh group.
      if (groupHasAgents) {
        inStarGroup = false;
        groupHasAgents = false;
      }
      if (value === '*') inStarGroup = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      groupHasAgents = true;
      if (!inStarGroup) continue;
      // A bare "Disallow:" means allow-all per the de-facto standard.
      if (value === '') continue;
      rules.push({ allow: field === 'allow', path: value });
    }
  }
  return {
    sitemaps,
    isAllowed(path: string): boolean {
      let best: RobotsRule | undefined;
      for (const rule of rules) {
        if (!path.startsWith(rule.path)) continue;
        if (
          best === undefined ||
          rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}
