import { readFile, stat } from 'node:fs/promises';
import {
  type AssistantAppearanceOverride,
  assistantAppearanceOverrideSchema,
} from '@noodle-borg/assistant-gateway/portable';
import type { ConfigLocation } from '../config.js';
import { ServiceRequestError, serviceJson } from '../control-plane.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { EXIT, printJsonOk } from './output.js';
import {
  parseCommandFlags,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
} from './shared.js';

const MAX_APPEARANCE_FILE_BYTES = 64 * 1024;

interface AppearanceResponse {
  readonly ok: true;
  readonly assistantEnabled: boolean;
  readonly revision: number;
  readonly fallback: 'halo';
  readonly developer: unknown | null;
  readonly override: unknown | null;
  readonly effective: unknown | null;
  readonly provenance: Readonly<Record<string, 'developer' | 'operator'>>;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export async function runAssistantAppearance(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...tail] = rest;
  const json = rest.includes('--json');
  if (action !== 'show' && action !== 'apply' && action !== 'reset') {
    return printCommandUsageFailure(
      'assistant appearance',
      'noodle assistant appearance requires show, apply, or reset',
      'noodle assistant appearance --help',
      json,
    );
  }

  const args = parseCommandFlags(tail, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--file': 'file',
      '--revision': 'revision',
    },
    booleans: { '--json': 'json' },
  });
  const invalidGrammar =
    args.parseError !== undefined ||
    args.positional.length > 0 ||
    (action === 'apply' ? args.file === undefined : args.file !== undefined) ||
    (action === 'show' && args.revision !== undefined);
  if (invalidGrammar) {
    return printCommandUsageFailure(
      'assistant appearance',
      action === 'apply'
        ? 'noodle assistant appearance apply requires --file <appearance.json>'
        : `noodle assistant appearance ${action} does not accept --file, --revision, or positional arguments`,
      `noodle assistant appearance ${action} --help`,
      args.json,
    );
  }

  const reviewedRevision = parseReviewedRevision(args.revision);
  if (args.revision !== undefined && reviewedRevision === undefined) {
    return printCommandUsageFailure(
      'assistant appearance',
      '--revision must be a nonnegative safe integer',
      `noodle assistant appearance ${action} --help`,
      args.json,
    );
  }

  let override: AssistantAppearanceOverride | undefined;
  if (action === 'apply') {
    const loaded = await readAppearanceFile(args.file as string);
    if (!loaded.ok) {
      return printCliFailure('assistant appearance', loaded.failure, args.json);
    }
    override = loaded.value;
  }

  const resolved = await resolveAnalyticsTarget('assistant appearance', args, env, home);
  if (typeof resolved === 'number') return resolved;
  const url = `${resolved.base}/assistant/appearance`;
  try {
    if (action === 'show') {
      const current = await serviceJson<AppearanceResponse>(url, resolved.token);
      printAppearance(current, resolved, args.json, 'Current');
      return EXIT.OK;
    }
    const expectedRevision =
      reviewedRevision ?? (await serviceJson<AppearanceResponse>(url, resolved.token)).revision;
    const body = await serviceJson<AppearanceResponse>(url, resolved.token, {
      method: action === 'apply' ? 'PUT' : 'DELETE',
      headers: {
        ...(action === 'apply' ? { 'content-type': 'application/json' } : {}),
        'if-match': `"${expectedRevision}"`,
      },
      ...(override !== undefined ? { body: JSON.stringify(override) } : {}),
    });
    printAppearance(body, resolved, args.json, action === 'apply' ? 'Applied' : 'Reset');
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 409) {
      return printCliFailure(
        'assistant appearance',
        {
          code: 'assistant_appearance_revision_conflict',
          message: 'The assistant appearance changed before this update completed.',
          cause: 'Another operator saved a newer environment revision.',
          fix: 'Review the current field provenance, then repeat the mutation with its displayed revision.',
          next: `noodle assistant appearance show --org ${resolved.org} --app ${resolved.app} --env ${resolved.env}`,
          exitCode: EXIT.FAILURE,
        },
        args.json,
      );
    }
    return printCliFailure(
      'assistant appearance',
      serviceFailure(
        'assistant appearance',
        error,
        `noodle assistant appearance ${action} --org ${resolved.org} --app ${resolved.app} --env ${resolved.env}`,
      ),
      args.json,
    );
  }
}

function parseReviewedRevision(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

async function readAppearanceFile(path: string): Promise<
  | { readonly ok: true; readonly value: AssistantAppearanceOverride }
  | {
      readonly ok: false;
      readonly failure: Parameters<typeof printCliFailure>[1];
    }
> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_APPEARANCE_FILE_BYTES) throw new Error('invalid');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const parsed = assistantAppearanceOverrideSchema.safeParse(value);
    if (!parsed.success) throw new Error('invalid');
    return { ok: true, value: parsed.data };
  } catch {
    return {
      ok: false,
      failure: {
        code: 'assistant_appearance_file_invalid',
        message: 'The assistant appearance file is invalid.',
        cause:
          'The file is unreadable, too large, malformed JSON, empty, or contains a field outside the browser-safe appearance contract.',
        fix: 'Provide one JSON object containing only supported branding and assistant UI settings.',
        next: 'noodle assistant appearance apply --file <appearance.json>',
        exitCode: EXIT.USAGE,
      },
    };
  }
}

function printAppearance(
  body: AppearanceResponse,
  target: { readonly org: string; readonly app: string; readonly env: string },
  json: boolean,
  verb: 'Current' | 'Applied' | 'Reset',
): void {
  const fields = Object.entries(body.provenance)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => ({ path, source }));
  const summary = {
    target: { org: target.org, app: target.app, env: target.env },
    assistantEnabled: body.assistantEnabled,
    revision: body.revision,
    fallback: body.fallback,
    hasOverride: body.override !== null,
    fields,
    ...(body.updatedAt !== undefined ? { updatedAt: body.updatedAt } : {}),
    ...(body.updatedBy !== undefined ? { updatedBy: body.updatedBy } : {}),
  };
  if (json) {
    printJsonOk(summary);
    return;
  }
  console.log(
    `${verb} assistant appearance for ${target.org}/${target.app}/${target.env}: revision ${body.revision}`,
  );
  console.log(
    body.override === null
      ? '  Override: none (developer settings, then built-in defaults)'
      : '  Override: active',
  );
  if (!body.assistantEnabled) console.log('  Assistant: disabled in the active deployment');
  if (fields.length === 0) console.log('  Fields: built-in defaults');
  else {
    console.log('  Field provenance:');
    for (const field of fields) console.log(`    ${field.source.padEnd(9)} ${field.path}`);
  }
  if (body.updatedBy !== undefined) console.log(`  Updated by: ${body.updatedBy}`);
}
