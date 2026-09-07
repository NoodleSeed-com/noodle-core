import { type ControlPlaneExchangeDeps, decideControlPlaneTokenExchange } from '@noodle-borg/auth';
import type { Request, Response } from 'express';

export {
  CONTROL_PLANE_EXCHANGE_AUDIENCE,
  CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
  type ControlPlaneExchangeDeps,
} from '@noodle-borg/auth';

/**
 * Express adapter for the inbound first-party control-plane token exchange (ADR 0218). The whole
 * decision — client auth, assertion verification, replay, policy ports, audit — lives Express-free in
 * `@noodle-borg/auth`; this file only maps HTTP on and off it.
 */
export async function handleDelegatedControlPlaneTokenExchange(
  req: Request,
  res: Response,
  deps: ControlPlaneExchangeDeps,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  const decision = await decideControlPlaneTokenExchange(
    {
      form:
        req.body !== null && typeof req.body === 'object'
          ? (req.body as Record<string, unknown>)
          : {},
      ...(typeof req.headers.authorization === 'string'
        ? { authorizationHeader: req.headers.authorization }
        : {}),
    },
    deps,
  );
  if (decision.wwwAuthenticate !== undefined) {
    res.setHeader('WWW-Authenticate', decision.wwwAuthenticate);
  }
  res.status(decision.status).json(decision.body);
}
