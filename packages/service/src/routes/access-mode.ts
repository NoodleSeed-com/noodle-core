import type { AccessMode } from '@noodle-borg/transport-http';

export function isIdentityAccessMode(accessMode: AccessMode): boolean {
  return (
    accessMode === 'owner-only' ||
    accessMode === 'org-members' ||
    accessMode === 'customers' ||
    accessMode === 'authenticated'
  );
}
