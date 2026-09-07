export interface SolutionInstallationRef {
  readonly org: string;
  readonly installationId?: string;
  readonly subject?: string;
  readonly collection?: string;
  readonly recordId?: string;
  readonly action?: 'grants' | 'records' | 'activity' | 'export';
}

export interface PublicSolutionIntakeRef {
  readonly publicId: string;
  readonly collection?: string;
}

function decoded(match: RegExpExecArray, index: number): string | undefined {
  const raw = match[index];
  if (raw === undefined) return undefined;
  try {
    const value = decodeURIComponent(raw);
    return value.length > 0 && value.length <= 128 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseSolutionInstallationPath(
  pathname: string,
): SolutionInstallationRef | undefined {
  let match = /^\/v1\/orgs\/([^/]+)\/solution-installations$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    return org === undefined ? undefined : { org };
  }
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    return org === undefined || installationId === undefined ? undefined : { org, installationId };
  }
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/grants$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    return org === undefined || installationId === undefined
      ? undefined
      : { org, installationId, action: 'grants' };
  }
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/grants\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    const subject = decoded(match, 3);
    return org === undefined || installationId === undefined || subject === undefined
      ? undefined
      : { org, installationId, subject, action: 'grants' };
  }
  match =
    /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/collections\/([^/]+)\/records(?:\/(export))?$/.exec(
      pathname,
    );
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    const collection = decoded(match, 3);
    return org === undefined || installationId === undefined || collection === undefined
      ? undefined
      : {
          org,
          installationId,
          collection,
          action: match[4] === 'export' ? 'export' : 'records',
        };
  }
  match =
    /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/collections\/([^/]+)\/records\/([^/]+)(?:\/(activity))?$/.exec(
      pathname,
    );
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    const collection = decoded(match, 3);
    const recordId = decoded(match, 4);
    return org === undefined ||
      installationId === undefined ||
      collection === undefined ||
      recordId === undefined
      ? undefined
      : {
          org,
          installationId,
          collection,
          recordId,
          action: match[5] === 'activity' ? 'activity' : 'records',
        };
  }
  return undefined;
}

export function parsePublicSolutionIntakePath(
  pathname: string,
): PublicSolutionIntakeRef | undefined {
  let match = /^\/v1\/solution-intake\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    const publicId = decoded(match, 1);
    return publicId === undefined ? undefined : { publicId };
  }
  match = /^\/v1\/solution-intake\/([^/]+)\/([^/]+)\/records$/.exec(pathname);
  if (match === null) return undefined;
  const publicId = decoded(match, 1);
  const collection = decoded(match, 2);
  return publicId === undefined || collection === undefined ? undefined : { publicId, collection };
}
