import {
  ApplicationActivityListClientResponseSchema,
  ApplicationActivityPreviewClientResponseSchema,
  ApplicationActivitySettingsClientResponseSchema,
  ApplicationActivitySettingsSaveRequestSchema,
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

const OUTCOME_LABELS = {
  dispatching: 'dispatching',
  completed: 'completed',
  rejected: 'rejected',
  returned: 'returned (completion unconfirmed)',
  accepted: 'accepted (pending external completion)',
  unknown: 'unknown (inspect the external system; do not retry blindly)',
} as const;

export async function runSolutionActivity(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const args = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--limit': 'limit',
      '--cursor': 'cursor',
      '--expected-revision': 'expectedRevision',
      '--retention-days': 'retentionDays',
    },
    booleans: { '--json': 'json' },
  });
  const fail = (message: string) =>
    printCliFailure(
      'solutions activity',
      usageError(
        message,
        'noodle solutions activity <list|export|preview> <installation> --org <org> | settings <get|set> <installation> --org <org>',
      ),
      args.json,
    );
  if (args.parseError) return fail(args.parseError);
  const [family, second, third] = args.positional;
  const isPage = family === 'list' || family === 'export';
  const direct = isPage || family === 'preview';
  const action = direct ? family : second;
  const installation = direct ? second : third;
  if (
    !installation ||
    !args.org ||
    (!direct && (family !== 'settings' || !['get', 'set'].includes(action ?? ''))) ||
    args.positional.length !== (direct ? 2 : 3)
  )
    return fail('A supported action, installation and --org are required.');
  if (
    (!isPage && (args.limit !== undefined || args.cursor !== undefined)) ||
    (action !== 'set' && (args.expectedRevision !== undefined || args.retentionDays !== undefined))
  )
    return fail(
      'Paging flags apply only to list and export; retention and revision apply only to settings set.',
    );
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    return fail('--limit must be an integer from 1 to 100.');
  if (args.cursor !== undefined && (args.cursor.length === 0 || args.cursor.length > 2048))
    return fail('--cursor must be a bounded opaque cursor.');
  const save = ApplicationActivitySettingsSaveRequestSchema.safeParse({
    expectedRevision: args.expectedRevision,
    retentionDays: Number(args.retentionDays),
  });
  if (action === 'set' && !save.success)
    return fail(
      'settings set requires --expected-revision from settings get and --retention-days from 1 to 365, within your plan maximum.',
    );
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure('solutions activity', authRequired(), args.json);
  const base = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/activity`;
  try {
    if (isPage) {
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      if (args.cursor !== undefined) query.set('cursor', args.cursor);
      const response = await serviceJson<unknown>(
        `${base}${family === 'export' ? '/export' : ''}${query.size ? `?${query}` : ''}`,
        resolved.token,
        {},
        options.fetchImpl ?? fetch,
      );
      const data = ApplicationActivityListClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          [
            `Activity within the ${data.historyDays}-day plan window.`,
            'Actor references are installation-scoped and do not imply verified identity.',
            ...data.activities.map(
              (entry) =>
                `${entry.startedAt}  ${entry.tool} / ${entry.operation}  ${OUTCOME_LABELS[entry.outcome]}  actor=${entry.actorReference ?? 'unavailable'} connection=${entry.connectionId ?? 'none'}  ${entry.id}`,
            ),
            ...(data.nextCursor === undefined ? [] : [`Next cursor: ${data.nextCursor}`]),
          ].join('\n'),
        );
    } else if (family === 'preview') {
      const response = await serviceJson<unknown>(
        `${base}/preview`,
        resolved.token,
        {},
        options.fetchImpl ?? fetch,
      );
      const data = ApplicationActivityPreviewClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          data.state === 'unavailable'
            ? 'A history impact preview needs a verified future paid-period end.'
            : [
                `Hypothetical history impact at ${data.paidPeriodEnd}; not a scheduled change.`,
                `As of ${data.asOf}: ${data.currentlyAccessibleCount} accessible terminal entries; ${data.physicallyExpiresByPeriodEndCount} expire by that date.`,
                ...data.scenarios.map(
                  (scenario) =>
                    `${scenario.label} (${scenario.maximumDays} days): ${scenario.additionallyHiddenAtPeriodEndCount} additional entries hidden.`,
                ),
                'Counts cover current visible terminal evidence only; future operations are not forecast.',
              ].join('\n'),
        );
    } else {
      const response = await serviceJson<unknown>(
        `${base}/settings`,
        resolved.token,
        action === 'set' && save.success
          ? {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(save.data),
            }
          : {},
        options.fetchImpl ?? fetch,
      );
      const data = ApplicationActivitySettingsClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          `Activity retention: ${data.retentionDays} day(s); plan maximum: ${data.maximumDays}.\nRevision: ${data.revision}\n${data.canEdit ? 'Administrators can change retention.' : 'Read-only for your role.'}`,
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions activity',
      serviceFailure(
        'solutions activity',
        error,
        `noodle solutions activity ${direct ? family : 'settings get'} <installation> --org <org>`,
      ),
      args.json,
    );
  }
}
