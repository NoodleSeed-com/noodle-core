import type { ControlPlaneAuthResult, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { OAuthStore } from '../oauth/store.js';

/** Restrict only verified Noodle tokens; registration purpose never comes from caller metadata. */
export function restrictPortalControlPlane(
  gate: DeployAuthGate,
  clients: Pick<OAuthStore, 'getClientPurpose'> | undefined,
  exchangeClientId?: string,
): DeployAuthGate {
  return {
    authorize: async (request) => {
      const authorization = await gate.authorize(request);
      if (!authorization.ok || authorization.identity?.oauthClientId === undefined)
        return authorization;
      let purpose: Awaited<ReturnType<OAuthStore['getClientPurpose']>>;
      try {
        purpose = await clients?.getClientPurpose(authorization.identity.oauthClientId);
      } catch {
        return denied('OAuth client authorization is unavailable');
      }
      // The confidential exchange is registered by protected host configuration, outside DCR.
      if (
        purpose === undefined &&
        authorization.identity.oauthClientId === exchangeClientId &&
        authorization.identity.developerGrantId !== undefined
      )
        return authorization;
      if (purpose === undefined) return denied('OAuth client registration is unavailable');
      if (purpose !== 'portal') return authorization;
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      return portalOperationAllowed(request.method ?? '', path)
        ? authorization
        : denied(
            'This Portal session cannot access developer operations. Sign in through the developer Console or CLI.',
          );
    },
  };
}

function denied(message: string): ControlPlaneAuthResult {
  return { ok: false, status: 403, message };
}

function portalOperationAllowed(method: string, path: string): boolean {
  if (
    method === 'GET' &&
    [
      '/v1/whoami',
      '/v1/me/solution-installations',
      '/v1/me/solution-installation-options',
      '/v1/solutions/catalog',
    ].includes(path)
  )
    return true;
  if (path === '/v1/solution-connections/callback') return method === 'POST';
  if (/^\/v1\/orgs\/[^/]+\/billing$/.test(path)) return method === 'GET';
  if (/^\/v1\/orgs\/[^/]+\/agreement$/.test(path)) return ['GET', 'POST'].includes(method);
  if (/^\/v1\/solution-invitations\/[^/]+\/accept$/.test(path)) return method === 'POST';
  const match = /^\/v1\/orgs\/[^/]+\/solution-installations(?:\/([^/]+)(?:\/(.+))?)?$/.exec(path);
  if (match === null) return false;
  if (match[1] === undefined) return ['GET', 'POST'].includes(method);
  const operation = match[2];
  if (operation === undefined) return ['GET', 'PATCH'].includes(method);
  if (/^(settings|channels|activity\/settings)$/.test(operation))
    return ['GET', 'PATCH'].includes(method);
  if (operation === 'notice') return ['GET', 'PUT'].includes(method);
  if (/^(activity(?:\/(?:export|preview))?|assignees|connections)$/.test(operation))
    return method === 'GET';
  if (/^connections\/[^/]+\/(connect|disconnect)$/.test(operation)) return method === 'POST';
  if (/^(grants|invitations)$/.test(operation)) return ['GET', 'POST'].includes(method);
  if (/^(grants|invitations)\/[^/]+$/.test(operation)) return method === 'DELETE';
  if (/^collections\/[^/]+\/source$/.test(operation)) return ['GET', 'PATCH'].includes(method);
  if (/^collections\/[^/]+\/source\/(pause|resume|refresh)$/.test(operation))
    return method === 'POST';
  if (/^collections\/[^/]+\/records$/.test(operation)) return ['GET', 'POST'].includes(method);
  if (/^collections\/[^/]+\/records\/[^/]+\/activity$/.test(operation)) return method === 'GET';
  if (/^collections\/[^/]+\/records\/export$/.test(operation)) return method === 'GET';
  return (
    /^collections\/[^/]+\/records\/[^/]+$/.test(operation) &&
    ['GET', 'PATCH', 'DELETE'].includes(method)
  );
}
