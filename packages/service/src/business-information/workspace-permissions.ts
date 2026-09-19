import type { WorkspacePermission } from '../business-workspaces/permissions.js';
import type { BusinessPermission } from './contracts.js';

/** Legacy operation vocabulary mapped to the one workspace matrix, not a second role matrix. */
const operations: Readonly<Record<BusinessPermission, WorkspacePermission | undefined>> = {
  'installation:administer': 'settings:manage',
  // Workspace team APIs own versioned membership; old installation grants cannot mutate it.
  'grants:manage': undefined,
  'records:create': 'records:write',
  'records:read': 'records:read',
  'records:update': 'records:write',
  'records:assign': 'records:write',
  'records:status': 'records:write',
  'records:note': 'records:write',
  'records:delete': 'records:erase',
  'records:export': 'records:export',
};

export function workspacePermissionForBusinessOperation(permission: BusinessPermission) {
  return operations[permission];
}
