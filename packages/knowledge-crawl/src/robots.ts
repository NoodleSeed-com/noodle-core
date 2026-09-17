/**
 * Bounded robots groups and longest-match rules. An explicit product token selects its exact
 * groups before wildcard groups; omitted token retains the crawler's wildcard-group behavior.
 * Supports percent-normalized paths, wildcard and end-anchor matching without a backtracking regex.
 */

interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface Robots {
  isAllowed(path: string): boolean;
  readonly sitemaps: readonly string[];
}

export function parseRobots(text: string, productToken = '*'): Robots {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  const sitemaps: string[] = [];
  let group = { agents: [] as string[], rules: [] as RobotsRule[] };
  groups.push(group);
  let ruleCount = 0;
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
      if (group.rules.length > 0) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      ruleCount += 1;
      if (ruleCount > 4096 || value.length > 2048 || (value !== '' && !value.startsWith('/'))) {
        throw new Error('robots_policy_invalid');
      }
      group.rules.push({ allow: field === 'allow', path: normalizePath(value) });
    }
  }
  const exact = groups.filter((entry) => entry.agents.includes(productToken.toLowerCase()));
  const selected = exact.length > 0 ? exact : groups.filter((entry) => entry.agents.includes('*'));
  const rules = selected.flatMap((entry) => entry.rules).filter((rule) => rule.path !== '');
  return {
    sitemaps,
    isAllowed(path: string): boolean {
      const normalized = normalizePath(path);
      let best: RobotsRule | undefined;
      for (const rule of rules) {
        if (!matches(normalized, rule.path)) continue;
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

function normalizePath(path: string): string {
  return path.replace(/%[0-9a-f]{2}|\P{ASCII}/giu, (part) => {
    if (!part.startsWith('%')) return encodeURIComponent(part);
    const decoded = String.fromCharCode(Number.parseInt(part.slice(1), 16));
    return /^[a-z0-9._~-]$/i.test(decoded) ? decoded : part.toUpperCase();
  });
}

function matches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = parts[0] ?? '';
  if (!path.startsWith(first)) return false;
  let position = first.length;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (anchored && i === parts.length - 1)
      return path.endsWith(part) && path.length - part.length >= position;
    const next = path.indexOf(part, position);
    if (next === -1) return false;
    position = next + part.length;
  }
  return !anchored || position === path.length;
}
