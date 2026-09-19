import type { BusinessWorkspaceRole } from '@noodle-borg/wire-contracts';

export type WorkspacePermission =
  | 'records:read'
  | 'records:write'
  | 'records:export'
  | 'records:erase'
  | 'drafts:read'
  | 'drafts:edit'
  | 'drafts:preview'
  | 'applications:publish'
  | 'settings:manage'
  | 'team:manage'
  | 'owners:manage'
  | 'billing:manage'
  | 'workspace:delete';
const operate = ['records:read', 'records:write'] as const;
const build = ['drafts:read', 'drafts:edit', 'drafts:preview'] as const;
const administer = [
  ...operate,
  ...build,
  'records:export',
  'records:erase',
  'applications:publish',
  'settings:manage',
  'team:manage',
] as const;

/** One fixed matrix, projected by clients; client-side visibility never supplies authorization. */
export const WORKSPACE_ROLE_PERMISSIONS: Readonly<
  Record<BusinessWorkspaceRole, readonly WorkspacePermission[]>
> = Object.freeze({
  owner: Object.freeze([
    ...administer,
    'owners:manage',
    'billing:manage',
    'workspace:delete',
  ] as const),
  administrator: Object.freeze(administer),
  builder: Object.freeze(build),
  operator: Object.freeze(operate),
  viewer: Object.freeze(['records:read'] as const),
});

export function mayDelegate(
  actor: BusinessWorkspaceRole | undefined,
  target: BusinessWorkspaceRole,
): boolean {
  return (
    actor === 'owner' ||
    (actor === 'administrator' && target !== 'owner' && target !== 'administrator')
  );
}
