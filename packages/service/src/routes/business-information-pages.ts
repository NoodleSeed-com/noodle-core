import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  BusinessPagePublishRequestSchema,
  BusinessPageResponseSchema,
  BusinessPageSaveRequestSchema,
  PublicBusinessPageResponseSchema,
} from '@noodle-borg/wire-contracts';
import {
  type BusinessPageChange,
  BusinessPageError,
} from '../business-information/business-page.js';
import {
  type BusinessPageRef,
  businessPageMethods,
} from '../business-information/business-page-paths.js';
import type { InstallationScope } from '../business-information/contracts.js';
import { requireIdentity, requireInstallationPermission } from './business-information.js';
import {
  type BusinessChannelRouteDeps,
  projectBusinessChannels,
} from './business-information-channels.js';

export interface BusinessPageRouteDeps extends BusinessChannelRouteDeps {
  readonly pageOrigin?: string | undefined;
  readonly pageServiceUrl?: string | undefined;
}

/** Publication custody remains valid independently of temporary assistant availability. */
async function pageContext(scope: InstallationScope, deps: BusinessPageRouteDeps) {
  const installation = await deps.store.getInstallation(scope);
  const generation = await deps.registry.getAppGeneration(scope.org, scope.app);
  if (
    !installation ||
    !generation ||
    installation.applicationGeneration !== generation ||
    (await deps.registry.getAppArchivedAt(scope.org, scope.app)) !== undefined ||
    !deps.pageOrigin ||
    !deps.pageServiceUrl ||
    (deps.businessOnboarding && !(await deps.businessOnboarding.ready(installation)))
  )
    throw new BusinessPageError('business_page_not_ready');
  const origin = new URL(deps.pageOrigin);
  if (
    origin.origin !== deps.pageOrigin ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    )
  )
    throw new BusinessPageError('business_page_not_ready');
  return { installation, origin: origin.origin, serviceUrl: deps.pageServiceUrl };
}

/** Only a current, explicitly configured public assistant can be attached to a hosted page. */
async function pageReadiness(scope: InstallationScope, deps: BusinessPageRouteDeps) {
  const { installation, origin, serviceUrl } = await pageContext(scope, deps);
  if (!installation.intakeActive || deps.publicIntakeEnabled === false)
    throw new BusinessPageError('business_page_not_ready');
  const channels = await projectBusinessChannels(installation, false, serviceUrl, deps);
  const assistant = channels.assistant;
  if (
    assistant.status !== 'ready' ||
    !assistant.origins.includes(origin) ||
    !channels.deploymentId ||
    !assistant.embedId ||
    !assistant.serviceUrl ||
    !assistant.scriptUrl
  )
    throw new BusinessPageError('business_page_not_ready');
  return {
    deploymentId: channels.deploymentId,
    assistant: {
      embedId: assistant.embedId,
      serviceUrl: assistant.serviceUrl,
      scriptUrl: assistant.scriptUrl,
    },
  };
}

export async function handleBusinessPage(
  req: IncomingMessage,
  res: ServerResponse,
  ref: BusinessPageRef,
  deps: BusinessPageRouteDeps,
): Promise<void> {
  res.setHeader('cache-control', 'private, no-store');
  if (!businessPageMethods(ref).includes(req.method ?? '')) {
    res.setHeader('allow', businessPageMethods(ref).join(', '));
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    'installation:administer',
    deps,
  );
  if (!authorized) return;
  try {
    let record = await deps.store.pages.get(authorized.scope);
    if (req.method !== 'GET') {
      const body = await readJsonBody(req, Math.min(deps.maxBody, 256 * 1024));
      if (!body.ok) return sendJson(res, body.status, { error: body.error });
      let change: BusinessPageChange;
      if (ref.operation) {
        const parsed = BusinessPagePublishRequestSchema.safeParse(body.value);
        if (!parsed.success) return invalidPage(res);
        change = { operation: ref.operation, ...parsed.data };
      } else {
        const parsed = BusinessPageSaveRequestSchema.safeParse(body.value);
        if (!parsed.success) return invalidPage(res);
        change = { operation: 'save', ...parsed.data };
      }
      record = await deps.store.pages.update(
        { scope: authorized.scope, actorSubject: identity.subject, change },
        () => pageReadiness(authorized.scope, deps),
      );
    }
    return sendJson(
      res,
      200,
      BusinessPageResponseSchema.parse({
        ok: true,
        data: {
          revision: record?.revision ?? 0,
          draft: record?.draft ?? null,
          published: record?.published ?? null,
          canEdit: true,
        },
      }),
    );
  } catch (error) {
    return pageFailure(res, error);
  }
}

export async function handlePublicBusinessPage(
  req: IncomingMessage,
  res: ServerResponse,
  publicId: string,
  deps: BusinessPageRouteDeps,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-robots-tag', 'noindex');
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  try {
    const installation = await deps.store.resolveInstallationByPublicId(publicId);
    if (!installation) return unavailablePage(res);
    const record = await deps.store.pages.get(installation.scope);
    if (!record?.published) return unavailablePage(res);
    await pageContext(installation.scope, deps);
    const notice = await deps.store.getBusinessNotice(installation.scope);
    if (notice?.revision !== record.published.noticeRevision) return unavailablePage(res);
    const ready = await pageReadiness(installation.scope, deps).catch((error: unknown) => {
      if (error instanceof BusinessPageError) return undefined;
      throw error;
    });
    return sendJson(
      res,
      200,
      PublicBusinessPageResponseSchema.parse({
        ok: true,
        data: {
          publicId,
          content: record.published.content,
          notice: record.published.notice,
          assistant: ready?.deploymentId === record.published.deploymentId ? ready.assistant : null,
        },
      }),
    );
  } catch (error) {
    if (error instanceof BusinessPageError) return unavailablePage(res);
    return pageFailure(res, error);
  }
}
function unavailablePage(res: ServerResponse): void {
  sendJson(res, 404, { code: 'page_unavailable', error: 'This page is not available.' });
}
function invalidPage(res: ServerResponse): void {
  sendJson(res, 400, {
    code: 'business_page_invalid',
    error: 'Check the page content and revision.',
  });
}
function pageFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof BusinessPageError) {
    sendJson(res, error.code === 'business_page_forbidden' ? 403 : 409, {
      code: error.code,
      error: error.message,
    });
    return;
  }
  // Neither decrypted content nor provider/parser exceptions may escape via generic route logging.
  sendJson(res, 503, {
    code: 'page_unavailable',
    error: 'The page service is temporarily unavailable.',
  });
}
