import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '@noodle-borg/transport-http';
import { proveManagedReaderFloor } from '../business-information/reader-floor.js';
import type { BusinessInformationRouteDeps } from './business-information.js';
import { authorizeControlPlane } from './control-plane.js';

/** Release-only compatibility proof. The response exposes counts and a digest, never tenant identities. */
export async function handleBusinessInformationReaderFloor(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return;
  const proof = await proveManagedReaderFloor(deps.store);
  sendJson(res, 200, { ok: true, ...proof });
}
