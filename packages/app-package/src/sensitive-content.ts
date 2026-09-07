export interface SensitiveContentFinding {
  readonly path: string;
  readonly kind:
    | 'private_key'
    | 'jwt'
    | 'github_token'
    | 'aws_access_key'
    | 'bearer_credential'
    | 'scan_limit';
}

const PATTERNS: readonly [SensitiveContentFinding['kind'], RegExp][] = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'jwt',
    /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9_-])/,
  ],
  ['github_token', /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer_credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?:$|[^A-Za-z0-9._~+/=-])/],
];

export function sensitiveContentFinding(value: unknown): SensitiveContentFinding | undefined {
  let visited = 0;
  const visit = (current: unknown, path: string): SensitiveContentFinding | undefined => {
    if (typeof current === 'string') {
      visited++;
      if (visited > 10_000) return { path: '', kind: 'scan_limit' };
      for (const [kind, pattern] of PATTERNS) if (pattern.test(current)) return { path, kind };
      return undefined;
    }
    if (Array.isArray(current))
      for (let index = 0; index < current.length; index++) {
        const found = visit(current[index], path ? `${path}.${index}` : String(index));
        if (found) return found;
      }
    else if (current !== null && typeof current === 'object')
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const found = visit(
          (current as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
        if (found) return found;
      }
    return undefined;
  };
  return visit(value, '');
}
