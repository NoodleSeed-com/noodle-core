export interface SolutionInstallationRef {
  readonly org: string;
  readonly installationId?: string;
  readonly subject?: string;
  readonly invitationId?: string;
  readonly collection?: string;
  readonly recordId?: string;
  readonly action?:
    | 'connections'
    | 'settings'
    | 'notice'
    | 'channels'
    | 'grants'
    | 'invitations'
    | 'assignees'
    | 'records'
    | 'activity'
    | 'export'
    | 'source';
  readonly connectionId?: string;
  readonly connectionAction?: 'connect' | 'disconnect';
  readonly sourceAction?: 'pause' | 'resume' | 'refresh';
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
  const connection =
    /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/connections(?:\/([^/]+)\/(connect|disconnect))?$/.exec(
      pathname,
    );
  if (connection !== null) {
    const org = decoded(connection, 1),
      installationId = decoded(connection, 2),
      connectionId = decoded(connection, 3);
    const connectionAction = connection[4] as SolutionInstallationRef['connectionAction'];
    return org === undefined ||
      installationId === undefined ||
      (connectionAction !== undefined && connectionId === undefined)
      ? undefined
      : {
          org,
          installationId,
          action: 'connections',
          ...(connectionId === undefined ? {} : { connectionId }),
          ...(connectionAction === undefined ? {} : { connectionAction }),
        };
  }
  const application =
    /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/(settings|notice|channels|activity(?:\/(?:settings|export|preview))?)$/.exec(
      pathname,
    );
  if (application !== null) {
    const org = decoded(application, 1);
    const installationId = decoded(application, 2);
    return org === undefined || installationId === undefined
      ? undefined
      : {
          org,
          installationId,
          action: application[3]?.startsWith('activity')
            ? 'activity'
            : (application[3] as 'settings' | 'notice' | 'channels'),
        };
  }
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
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/invitations$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    return org === undefined || installationId === undefined
      ? undefined
      : { org, installationId, action: 'invitations' };
  }
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/invitations\/([^/]+)$/.exec(
    pathname,
  );
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    const invitationId = decoded(match, 3);
    return org === undefined || installationId === undefined || invitationId === undefined
      ? undefined
      : { org, installationId, invitationId, action: 'invitations' };
  }
  match = /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/assignees$/.exec(pathname);
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    return org === undefined || installationId === undefined
      ? undefined
      : { org, installationId, action: 'assignees' };
  }
  match =
    /^\/v1\/orgs\/([^/]+)\/solution-installations\/([^/]+)\/collections\/([^/]+)\/source(?:\/(pause|resume|refresh))?$/.exec(
      pathname,
    );
  if (match !== null) {
    const org = decoded(match, 1);
    const installationId = decoded(match, 2);
    const collection = decoded(match, 3);
    const sourceAction = match[4] as SolutionInstallationRef['sourceAction'];
    return org === undefined || installationId === undefined || collection === undefined
      ? undefined
      : {
          org,
          installationId,
          collection,
          action: 'source',
          ...(sourceAction === undefined ? {} : { sourceAction }),
        };
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

export function parseSolutionInvitationAcceptPath(pathname: string): string | undefined {
  const match = /^\/v1\/solution-invitations\/([^/]+)\/accept$/.exec(pathname);
  return match === null ? undefined : decoded(match, 1);
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
