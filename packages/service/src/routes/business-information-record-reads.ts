import type { ServerResponse } from 'node:http';
import { sendJson } from '@noodle-borg/transport-http';
import type {
  BusinessInformationStore,
  InstallationScope,
} from '../business-information/contracts.js';
import { NativeQueryError } from '../business-information/native-query.js';
import { CursorValidationError } from '../business-information/validation.js';
import { parseBusinessPaging } from './business-information-request.js';
import { activityToWire } from './business-information-wire.js';

export async function sendNativeRecordActivity(
  res: ServerResponse,
  url: URL,
  scope: InstallationScope,
  collection: string,
  id: string,
  store: BusinessInformationStore,
): Promise<void> {
  const paging = parseBusinessPaging(url, 100);
  if (!paging.ok) return sendJson(res, 400, { error: paging.error });
  const history = await cursorRequest(res, () =>
    store.listActivity(scope, collection, id, paging.value),
  );
  if (history === undefined) return;
  return sendJson(res, 200, {
    ok: true,
    data: { ...history, activities: history.activities.map(activityToWire) },
  });
}

export async function cursorRequest<T>(
  res: ServerResponse,
  request: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof NativeQueryError) {
      sendJson(res, error.code === 'query_limit_exceeded' ? 422 : 400, {
        error: error.message,
        code: error.code,
      });
      return undefined;
    }
    if (!(error instanceof CursorValidationError)) throw error;
    sendJson(res, 400, { error: 'cursor is invalid', code: 'invalid_cursor' });
    return undefined;
  }
}
