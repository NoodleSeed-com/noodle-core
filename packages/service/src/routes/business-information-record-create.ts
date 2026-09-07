import type { ServerResponse } from 'node:http';
import { sendJson } from '@noodle-borg/transport-http';
import {
  type BusinessInformationStore,
  PayloadValidationError,
  type SolutionInstallation,
} from '../business-information/portable.js';
import type { BusinessInformationRouteDeps } from './business-information.js';

export async function createNativeRecord(
  res: ServerResponse,
  deps: BusinessInformationRouteDeps,
  input: {
    readonly installation: SolutionInstallation;
    readonly collection: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
    readonly origin: { readonly kind: 'portal' | 'embedded'; readonly reference?: string };
    readonly actorSubject: string;
    readonly admit?: () => Promise<boolean>;
  },
): Promise<Awaited<ReturnType<BusinessInformationStore['createRequest']>> | undefined> {
  try {
    const request = {
      scope: input.installation.scope,
      collectionKey: input.collection,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      origin: input.origin,
      actorSubject: input.actorSubject,
    };
    if (input.admit) {
      const receipt = await deps.store.probeRequest(request);
      if (receipt.disposition !== 'missing') return receipt;
      if (!(await input.admit())) return undefined;
    }
    return await deps.store.createRequest(request);
  } catch (error) {
    if (!(error instanceof PayloadValidationError)) throw error;
    sendJson(res, 400, { error: error.message, code: error.code });
    return undefined;
  }
}
