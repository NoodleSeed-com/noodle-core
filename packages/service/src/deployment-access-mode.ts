import type { AccessMode } from '@noodle-borg/transport-http';
import { parse as parseYaml } from 'yaml';

export function isIdentityAccessMode(accessMode: AccessMode, manifest?: string): boolean {
  if (accessMode === 'mixed' && manifest !== undefined) {
    try {
      const parsed: unknown = parseYaml(manifest);
      if (typeof parsed === 'object' && parsed !== null && 'server' in parsed) {
        const server = parsed.server;
        if (
          typeof server === 'object' &&
          server !== null &&
          'auth' in server &&
          server.auth != null
        )
          return true;
      }
    } catch {
      /* Compilation owns malformed manifest diagnostics. */
    }
  }
  return (
    accessMode === 'owner-only' ||
    accessMode === 'org-members' ||
    accessMode === 'customers' ||
    accessMode === 'authenticated'
  );
}
