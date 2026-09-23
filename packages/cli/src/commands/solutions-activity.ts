import {
  ApplicationActivityListClientResponseSchema,
  ApplicationActivityPreviewClientResponseSchema,
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
    },
    booleans: { '--json': 'json' },
  });
  const fail = (message: string) =>
    printCliFailure(
      'solutions activity',
      usageError(
        message,
        'noodle solutions activity <list|export|preview> <installation> --org <org>',
      ),
      args.json,
    );
  if (args.parseError) return fail(args.parseError);
  const [family, installation] = args.positional;
  const isPage = family === 'list' || family === 'export';
  if (
    !installation ||
    !args.org ||
    (!isPage && family !== 'preview') ||
    args.positional.length !== 2
  )
    return fail('A supported action, installation and --org are required.');
  if (!isPage && (args.limit !== undefined || args.cursor !== undefined))
    return fail('Paging flags apply only to list and export.');
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    return fail('--limit must be an integer from 1 to 100.');
  if (args.cursor !== undefined && (args.cursor.length === 0 || args.cursor.length > 2048))
    return fail('--cursor must be a bounded opaque cursor.');
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
            `Activity within your current ${data.historyDays}-day history window.`,
            'Actor references are installation-scoped and do not imply verified identity.',
            ...data.activities.map(
              (entry) =>
                `${entry.startedAt}  ${entry.tool} / ${entry.operation}  ${OUTCOME_LABELS[entry.outcome]}  actor=${entry.actorReference ?? 'unavailable'} connection=${entry.connectionId ?? 'none'}  ${entry.id}`,
            ),
            ...(data.nextCursor === undefined ? [] : [`Next cursor: ${data.nextCursor}`]),
          ].join('\n'),
        );
    } else {
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
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions activity',
      serviceFailure(
        'solutions activity',
        error,
        `noodle solutions activity ${family} <installation> --org <org>`,
      ),
      args.json,
    );
  }
}
