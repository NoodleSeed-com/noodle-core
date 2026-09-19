const root =
  /^\/v1\/orgs\/([a-z0-9][a-z0-9-]{0,62})\/business-workspace(?:\/(members|accept|invitations)(?:\/([a-f0-9-]{36}))?)?$/;
export function parseBusinessWorkspacePath(path: string) {
  const match = root.exec(path);
  if (!match?.[1] || (match[3] && match[2] !== 'invitations')) return undefined;
  return { org: match[1], action: match[2], id: match[3] };
}
export function businessWorkspaceMethod(
  ref: NonNullable<ReturnType<typeof parseBusinessWorkspacePath>>,
): string {
  if (!ref.action) return 'GET';
  if (ref.action === 'members') return 'PATCH';
  if (ref.action === 'invitations' && ref.id) return 'DELETE';
  return 'POST';
}
