export type IssuerMetadataKind = 'openid-configuration' | 'oauth-authorization-server';

export interface IssuerMetadataCandidate {
  readonly kind: IssuerMetadataKind;
  readonly url: string;
  readonly compatibility: 'mcp' | 'legacy';
}

export interface DiscoveredIssuerMetadata<T> extends IssuerMetadataCandidate {
  readonly metadata: T;
}

/** MCP-ordered discovery URLs, with the prior path-appended RFC form retained last for compatibility. */
export function issuerMetadataCandidates(issuer: string): readonly IssuerMetadataCandidate[] {
  const parsed = new URL(issuer);
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const normalizedIssuer = `${parsed.origin}${normalizedPath}`;
  const pathSuffix = normalizedPath === '' ? '' : normalizedPath;
  const candidates: IssuerMetadataCandidate[] = [
    {
      kind: 'oauth-authorization-server',
      url: `${parsed.origin}/.well-known/oauth-authorization-server${pathSuffix}`,
      compatibility: 'mcp',
    },
    {
      kind: 'openid-configuration',
      url: `${parsed.origin}/.well-known/openid-configuration${pathSuffix}`,
      compatibility: 'mcp',
    },
  ];
  if (pathSuffix !== '') {
    candidates.push(
      {
        kind: 'openid-configuration',
        url: `${normalizedIssuer}/.well-known/openid-configuration`,
        compatibility: 'mcp',
      },
      {
        kind: 'oauth-authorization-server',
        url: `${normalizedIssuer}/.well-known/oauth-authorization-server`,
        compatibility: 'legacy',
      },
    );
  }
  return candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.url === candidate.url) === index,
  );
}

/** Standards-ordered issuer discovery shared by runtime verification and CLI diagnostics. */
export async function discoverIssuerMetadata<T extends { readonly issuer?: unknown }>(
  issuer: string,
  load: (url: string) => Promise<T>,
): Promise<DiscoveredIssuerMetadata<T>> {
  const normalizedIssuer = normalizeIssuer(issuer);
  let firstError: unknown;
  for (const candidate of issuerMetadataCandidates(issuer)) {
    try {
      const metadata = await load(candidate.url);
      if (
        typeof metadata.issuer !== 'string' ||
        normalizeIssuer(metadata.issuer) !== normalizedIssuer
      ) {
        throw new Error(`issuer metadata mismatch at ${candidate.url}`);
      }
      return { metadata, ...candidate };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error('issuer metadata discovery failed');
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}
