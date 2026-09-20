import { validateSlug } from '@noodle-borg/control-plane/portable';
import { ApplicationDraftIdSchema } from '@noodle-borg/wire-contracts';

export function parseApplicationDraftPath(path: string) {
  const match =
    /^\/v1\/orgs\/([a-z0-9-]+)\/apps\/([a-z0-9-]+)\/drafts(?:\/([a-f0-9-]+)(?:\/(undo|history|diff|validate))?)?$/.exec(
      path,
    );
  const org = match?.[1],
    app = match?.[2],
    id = match?.[3],
    action = match?.[4];
  if (!org || !app || (id !== undefined && !ApplicationDraftIdSchema.safeParse(id).success))
    return undefined;
  try {
    validateSlug('org', org);
    validateSlug('app', app);
  } catch {
    return undefined;
  }
  return { org, app, ...(id ? { id } : {}), ...(action ? { action } : {}) };
}

export function applicationDraftMethods(
  ref: NonNullable<ReturnType<typeof parseApplicationDraftPath>>,
): readonly string[] {
  return ref.action === 'undo' || ref.action === 'validate'
    ? ['POST']
    : ref.action
      ? ['GET']
      : ref.id
        ? ['GET', 'PATCH', 'DELETE']
        : ['GET', 'POST'];
}
