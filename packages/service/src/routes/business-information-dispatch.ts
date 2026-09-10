import type { IncomingMessage, ServerResponse } from 'node:http';
import { OrganizationAgreementError } from '@noodle-borg/control-plane/portable';
import { type Logger, sendJson, type TlsPosture } from '@noodle-borg/transport-http';
import { BusinessNoticeError } from '../business-information/business-notice.js';
import { InstallationCapacityError } from '../business-information/installation-capacity.js';
import { NativeStorageLimitError } from '../business-information/native-storage-budget.js';
import { SourceCredentialError } from '../business-information/source-credential-fence.js';
import { SourceCapacityError } from '../business-information/source-custody-budget.js';
import { respondRouteError } from '../http-util.js';
import {
  type BusinessInformationRouteDeps,
  handleBusinessGrants,
  handleManagedRecords,
  handleSolutionCatalog,
  handleSolutionInstallations,
} from './business-information.js';
import {
  type BusinessActivityRouteDeps,
  handleApplicationActivity,
} from './business-information-activity.js';
import {
  type BusinessChannelRouteDeps,
  handleBusinessChannels,
} from './business-information-channels.js';
import {
  type BusinessConnectionRouteDeps,
  handleApplicationConnectionCallback,
  handleApplicationConnections,
} from './business-information-connections.js';
import {
  handleBusinessNotice,
  handleOrganizationAgreement,
} from './business-information-notice.js';
import { handleSolutionInstallationOptions } from './business-information-onboarding.js';
import {
  parsePublicSolutionIntakePath,
  parseSolutionInstallationPath,
  parseSolutionInvitationAcceptPath,
} from './business-information-paths.js';
import { handlePublicSolutionIntake } from './business-information-public.js';
import { handleBusinessInformationReaderFloor } from './business-information-reader-floor.js';
import { handleBusinessSettings } from './business-information-settings.js';
import { handleCollectionSource } from './business-information-source.js';
import {
  handleBusinessInvitationAccept,
  handleBusinessInvitations,
  handleEligibleBusinessAssignees,
  handleMySolutionInstallations,
} from './business-information-staff.js';

export interface BusinessInformationDispatchDeps
  extends BusinessActivityRouteDeps,
    BusinessConnectionRouteDeps,
    Partial<Omit<BusinessChannelRouteDeps, keyof BusinessInformationRouteDeps>> {
  readonly logger: Logger;
  readonly tls: TlsPosture;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
}

export function dispatchBusinessInformationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: BusinessInformationDispatchDeps,
): boolean {
  const agreement = /^\/v1\/orgs\/([a-z0-9][a-z0-9-]{0,62})\/agreement$/.exec(url.pathname);
  if (agreement?.[1])
    return run(req, res, deps, () =>
      handleOrganizationAgreement(req, res, agreement[1] as string, deps),
    );
  if (url.pathname === '/v1/solution-connections/callback')
    return run(req, res, deps, () => handleApplicationConnectionCallback(req, res, deps));
  if (url.pathname === '/v1/service/business-information-reader-floor') {
    return run(req, res, deps, () => handleBusinessInformationReaderFloor(req, res, deps));
  }
  if (url.pathname === '/v1/solutions/catalog') {
    return run(req, res, deps, () => Promise.resolve(handleSolutionCatalog(req, res)));
  }
  if (url.pathname === '/v1/me/solution-installations') {
    return run(req, res, deps, () => handleMySolutionInstallations(req, res, deps));
  }
  if (url.pathname === '/v1/me/solution-installation-options')
    return run(req, res, deps, () => handleSolutionInstallationOptions(req, res, deps));
  const invitationToken = parseSolutionInvitationAcceptPath(url.pathname);
  if (invitationToken !== undefined) {
    return run(req, res, deps, () =>
      handleBusinessInvitationAccept(req, res, invitationToken, deps),
    );
  }
  const publicRef = parsePublicSolutionIntakePath(url.pathname);
  if (publicRef !== undefined) {
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    applyPublicIntakeCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    void handlePublicSolutionIntake(req, res, publicRef, deps).catch((error: unknown) =>
      respondBusinessError(deps, res, 'business_information.public_route.failed', error),
    );
    return true;
  }
  const installationRef = parseSolutionInstallationPath(url.pathname);
  if (installationRef === undefined) return false;
  if (installationRef.action === 'notice')
    return run(req, res, deps, () => handleBusinessNotice(req, res, installationRef, deps));
  if (
    (installationRef.action === 'activity' || installationRef.action === 'coordination') &&
    installationRef.collection === undefined
  )
    return run(req, res, deps, () =>
      handleApplicationActivity(req, res, url, installationRef, deps),
    );
  if (installationRef.action === 'connections')
    return run(req, res, deps, () => handleApplicationConnections(req, res, installationRef, deps));
  if (installationRef.action === 'settings') {
    return run(req, res, deps, () => handleBusinessSettings(req, res, installationRef, deps));
  }
  if (
    installationRef.action === 'channels' &&
    deps.registry !== undefined &&
    deps.resolveEndpointBase !== undefined
  ) {
    const channelDeps = {
      ...deps,
      registry: deps.registry,
      resolveEndpointBase: deps.resolveEndpointBase,
    };
    return run(req, res, deps, () =>
      handleBusinessChannels(req, res, installationRef, channelDeps),
    );
  }
  if (installationRef.action === 'grants') {
    return run(req, res, deps, () => handleBusinessGrants(req, res, installationRef, deps));
  }
  if (installationRef.action === 'invitations') {
    return run(req, res, deps, () => handleBusinessInvitations(req, res, installationRef, deps));
  }
  if (installationRef.action === 'assignees') {
    return run(req, res, deps, () =>
      handleEligibleBusinessAssignees(req, res, installationRef, deps),
    );
  }
  if (installationRef.action === 'source') {
    return run(req, res, deps, () => handleCollectionSource(req, res, installationRef, deps));
  }
  if (
    installationRef.action === 'records' ||
    installationRef.action === 'activity' ||
    installationRef.action === 'export'
  ) {
    return run(req, res, deps, () => handleManagedRecords(req, res, url, installationRef, deps));
  }
  return run(req, res, deps, () => handleSolutionInstallations(req, res, installationRef, deps));
}

function applyPublicIntakeCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type, Idempotency-Key');
  res.setHeader('access-control-max-age', '600');
}

function run(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationDispatchDeps,
  handle: () => Promise<void>,
): true {
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  void handle().catch((error: unknown) =>
    respondBusinessError(deps, res, 'business_information.route.failed', error),
  );
  return true;
}

function respondBusinessError(
  deps: BusinessInformationDispatchDeps,
  res: ServerResponse,
  event: string,
  error: unknown,
): void {
  if (error instanceof OrganizationAgreementError || error instanceof BusinessNoticeError) {
    const forbidden =
      error.code === 'agreement_owner_required' || error.code === 'business_notice_forbidden';
    sendJson(res, forbidden ? 403 : 409, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof SourceCredentialError) {
    sendJson(res, 503, {
      error: 'Collection source authorization changed; reconnect and replace its binding.',
      code: 'source_unavailable',
    });
    return;
  }
  if (
    error instanceof NativeStorageLimitError ||
    error instanceof SourceCapacityError ||
    error instanceof InstallationCapacityError
  ) {
    sendJson(res, 409, { error: error.message, code: error.code });
    return;
  }
  respondRouteError(deps.logger, res, event, error);
}
