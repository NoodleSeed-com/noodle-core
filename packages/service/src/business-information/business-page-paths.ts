export interface BusinessPageRef {
  readonly org: string;
  readonly installationId: string;
  readonly operation?: 'publish' | 'unpublish';
}
export function parseBusinessPagePath(path: string): BusinessPageRef | undefined {
  const match =
    /^\/v1\/orgs\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/solution-installations\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/page(?:\/(publish|unpublish))?$/.exec(
      path,
    );
  return match
    ? {
        org: match[1]!,
        installationId: match[2]!,
        ...(match[3] ? { operation: match[3] as 'publish' | 'unpublish' } : {}),
      }
    : undefined;
}
export function businessPageMethods(ref: BusinessPageRef): readonly string[] {
  return ref.operation ? ['POST'] : ['GET', 'PUT'];
}
