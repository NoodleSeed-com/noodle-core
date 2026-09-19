import {
  ApplicationDraftClientResponseSchema,
  ApplicationDraftDiffClientResponseSchema,
  ApplicationDraftHistoryClientResponseSchema,
  ApplicationDraftIdSchema,
  ApplicationDraftListClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';
import { readDraftSource } from './solutions-draft-source.js';

const usage =
  'noodle solutions drafts <list|show|history|diff|create|edit|undo|delete> [draft-id] --org <org> --app <app> [--json]';
export async function runSolutionDrafts(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  location: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = 'solutions drafts';
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--org': 'org',
      '--app': 'app',
      '--env': 'env',
      '--source-dir': 'sourceDir',
      '--entrypoint': 'entrypoint',
      '--expected-revision': 'expectedRevision',
      '--revision': 'revision',
      '--target-revision': 'targetRevision',
      '--from-revision': 'fromRevision',
      '--to-revision': 'toRevision',
      '--idempotency-key': 'idempotencyKey',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const [operation, id, ...extra] = args.positional;
  const invalid = (message: string) =>
    printCliFailure(command, usageError(message, usage), args.json);
  const needsId =
    operation && ['show', 'history', 'diff', 'edit', 'undo', 'delete'].includes(operation);
  const reads = operation && ['list', 'show', 'history', 'diff'].includes(operation);
  const needsSource = operation === 'create' || operation === 'edit';
  const needsRevision = operation === 'edit' || operation === 'undo' || operation === 'delete';
  const needsKey = operation === 'create' || operation === 'edit' || operation === 'undo';
  if (
    args.parseError ||
    !operation ||
    !['list', 'show', 'history', 'diff', 'create', 'edit', 'undo', 'delete'].includes(operation) ||
    !args.org ||
    !args.app ||
    extra.length ||
    (needsId ? !ApplicationDraftIdSchema.safeParse(id).success : id !== undefined)
  ) {
    return invalid(
      args.parseError ?? 'Supply a supported operation and explicit organization/application.',
    );
  }
  if (
    (!needsSource && (args.sourceDir !== undefined || args.entrypoint !== undefined)) ||
    (!needsRevision && args.expectedRevision !== undefined) ||
    (!needsKey && args.idempotencyKey !== undefined) ||
    (operation !== 'undo' && args.targetRevision !== undefined) ||
    (operation !== 'create' && args.env !== undefined) ||
    (operation !== 'diff' && (args.fromRevision !== undefined || args.toRevision !== undefined)) ||
    (operation !== 'delete' && args.confirm)
  )
    return invalid('A flag does not apply to the selected draft operation.');
  if (needsSource && !args.sourceDir)
    return invalid('--source-dir is required; author the application in TypeScript.');
  if (needsRevision && !positiveRevision(args.expectedRevision))
    return invalid('--expected-revision is required.');
  if (needsKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey ?? ''))
    return invalid('--idempotency-key is required.');
  if (operation === 'undo' && !positiveRevision(args.targetRevision))
    return invalid('--target-revision is required.');
  if (
    operation === 'diff' &&
    (!positiveRevision(args.fromRevision) || !positiveRevision(args.toRevision))
  )
    return invalid('--from-revision and --to-revision are required.');
  if (args.revision !== undefined && (operation !== 'show' || !positiveRevision(args.revision)))
    return invalid('--revision is only supported for show.');
  if (operation === 'delete' && !args.confirm)
    return invalid(
      '--confirm is required to erase this draft and its source history; published applications are separate.',
    );
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home: location,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  const base = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/apps/${encodeURIComponent(args.app)}/drafts`;
  const suffix = ['undo', 'history', 'diff'].includes(operation) ? `/${operation}` : '';
  const query =
    operation === 'diff'
      ? `?from=${args.fromRevision}&to=${args.toRevision}`
      : args.revision
        ? `?revision=${args.revision}`
        : '';
  const path = `${base}${id ? `/${id}` : ''}${suffix}${query}`;
  try {
    const source =
      needsSource && args.sourceDir
        ? await readDraftSource(args.sourceDir, args.entrypoint)
        : undefined;
    const body =
      operation === 'create'
        ? { environment: args.env ?? 'prod', source }
        : operation === 'edit'
          ? { expectedRevision: Number(args.expectedRevision), source }
          : operation === 'undo'
            ? {
                expectedRevision: Number(args.expectedRevision),
                targetRevision: Number(args.targetRevision),
              }
            : operation === 'delete'
              ? { expectedRevision: Number(args.expectedRevision) }
              : undefined;
    const result = await serviceJson<unknown>(
      path,
      resolved.token,
      {
        method: reads
          ? 'GET'
          : operation === 'edit'
            ? 'PATCH'
            : operation === 'delete'
              ? 'DELETE'
              : 'POST',
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(needsKey && args.idempotencyKey ? { 'idempotency-key': args.idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      options.fetchImpl ?? fetch,
    );
    if (operation === 'delete') {
      if (args.json) printJsonOk({ draftId: id, deleted: true });
      else console.log('Draft source erased. Published applications are unchanged.');
    } else if (operation === 'history') {
      const data = ApplicationDraftHistoryClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          data.revisions
            .map((item) => `${item.revision}  ${item.updatedAt}  ${item.origin}`)
            .join('\n'),
        );
    } else if (operation === 'diff') {
      const data = ApplicationDraftDiffClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          `Revision ${data.diff.fromRevision} → ${data.diff.toRevision}: ${data.diff.changes.length} changed files. Use --json to inspect exact changes.`,
        );
    } else if (operation === 'list') {
      const data = ApplicationDraftListClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          data.drafts
            .map((draft) => `${draft.id}  revision ${draft.revision}  ${draft.environment}`)
            .join('\n') || 'No saved drafts.',
        );
    } else {
      const data = ApplicationDraftClientResponseSchema.parse(result).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          `Draft ${data.draft.id} · revision ${data.draft.revision}\nSource digest: ${data.draft.sourceDigest}\nNot published. Use --json to inspect source.`,
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, serviceFailure(command, error, usage), args.json);
  }
}
function positiveRevision(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
}
