import {
  OperationCoordinationListClientResponseSchema,
  OperationCoordinationListRequestSchema,
  OperationCoordinationResolveClientResponseSchema,
  OperationCoordinationResolveRequestSchema,
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

const USAGE =
  'noodle solutions operations coordination <list|resolve> <installation> --org <org>; resolve requires --resource <hash> --token <token> --reason <review>';
export async function runSolutionOperations(
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
      '--before-resource': 'beforeResource',
      '--resource': 'resource',
      '--token': 'coordinationToken',
      '--reason': 'reason',
    },
    booleans: { '--json': 'json' },
  });
  const fail = (message: string) =>
    printCliFailure('solutions operations coordination', usageError(message, USAGE), args.json);
  if (args.parseError) return fail(args.parseError);
  const [family, action, installation] = args.positional;
  if (
    family !== 'coordination' ||
    !['list', 'resolve'].includes(action ?? '') ||
    !installation ||
    !args.org ||
    args.positional.length !== 3
  )
    return fail('A coordination action, installation and --org are required.');
  if (
    (action === 'list' &&
      [args.resource, args.coordinationToken, args.reason].some((value) => value !== undefined)) ||
    (action === 'resolve' && [args.limit, args.beforeResource].some((value) => value !== undefined))
  )
    return fail('Paging applies only to list; resource, token and reason apply only to resolve.');
  const paging = OperationCoordinationListRequestSchema.safeParse({
    ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
    ...(args.beforeResource === undefined ? {} : { beforeResource: args.beforeResource }),
  });
  const review = OperationCoordinationResolveRequestSchema.safeParse({
    resource: args.resource,
    token: args.coordinationToken,
    reason: args.reason,
  });
  if (action === 'list' && !paging.success)
    return fail('Use a limit from 1 to 100 and the resource cursor returned by list.');
  if (action === 'resolve' && !review.success)
    return fail(
      'Resolution requires the exact resource and token plus a single-line review reason of 1 to 256 characters.',
    );
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token)
    return printCliFailure('solutions operations coordination', authRequired(), args.json);
  const base = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/operations/coordination`;
  try {
    if (action === 'list' && paging.success) {
      const query = new URLSearchParams();
      if (paging.data.limit !== undefined) query.set('limit', String(paging.data.limit));
      if (paging.data.beforeResource !== undefined)
        query.set('beforeResource', paging.data.beforeResource);
      const response = await serviceJson<unknown>(
        `${base}${query.size ? `?${query}` : ''}`,
        resolved.token,
        {},
        options.fetchImpl ?? fetch,
      );
      const data = OperationCoordinationListClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          [
            'Administrative operation custody. Verify the external outcome before resolving a hold.',
            ...data.records.map(
              (record) =>
                `${record.resource}  ${record.state}  deadline=${record.deadline}\n  reference=${record.reference} token=${record.token}`,
            ),
            ...(data.nextBeforeResource
              ? [`Next resource cursor: ${data.nextBeforeResource}`]
              : []),
          ].join('\n'),
        );
    } else if (review.success) {
      const response = await serviceJson<unknown>(
        `${base}/resolve`,
        resolved.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(review.data),
        },
        options.fetchImpl ?? fetch,
      );
      const data = OperationCoordinationResolveClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          'Reviewed hold released. No external operation was executed or its recorded outcome changed.',
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions operations coordination',
      serviceFailure('solutions operations coordination', error, USAGE),
      args.json,
    );
  }
}
