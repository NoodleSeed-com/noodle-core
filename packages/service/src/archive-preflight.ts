import type { ServerResponse } from 'node:http';
import type { TenantRouteRef } from '@noodle-borg/transport-http';
import { sendJson } from '@noodle-borg/transport-http';
import type { ServerRegistry } from './registry.js';

export function createArchivePreflight(registry: ServerRegistry) {
  return async (ref: TenantRouteRef, _req: unknown, res: ServerResponse): Promise<boolean> => {
    let archivedAt: string | undefined;
    try {
      archivedAt = await registry.getAppArchivedAt(ref.org, ref.app);
    } catch {
      archivedAt = undefined;
    }
    if (archivedAt === undefined) return true;
    sendJson(res, 410, {
      error: 'app archived: MCP endpoints for this app are disabled until its owner restores it',
    });
    return false;
  };
}
