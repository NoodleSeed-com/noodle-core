import { readFile } from 'node:fs/promises';
import {
  BillingCatalogActivationClientResponseSchema,
  BillingCatalogActivationRequestSchema,
  BillingCatalogStatusClientResponseSchema,
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

/** The CLI submits the same protected release evidence; it has no database or allowance override. */
export async function runBillingCatalog(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const args = parseCommandFlags(rest, {
    values: { '--service': 'service', '--auth-token': 'authToken', '--proof': 'proof' },
    booleans: { '--json': 'json' },
  });
  const action = args.positional[0];
  const fail = (message: string) =>
    printCliFailure(
      'billing catalog',
      usageError(message, 'noodle billing catalog <status|activate --proof <file>>'),
      args.json,
    );
  if (args.parseError) return fail(args.parseError);
  if (args.positional.length !== 1 || (action !== 'status' && action !== 'activate'))
    return fail('Choose status or activate.');
  if ((action === 'activate') !== Boolean(args.proof))
    return fail('Only activate requires --proof.');
  const auth = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!auth.token) return printCliFailure('billing catalog', authRequired(), args.json);
  let body: unknown;
  if (action === 'activate') {
    try {
      body = BillingCatalogActivationRequestSchema.parse(
        JSON.parse(await readFile(args.proof as string, 'utf8')),
      );
    } catch {
      return fail('Unable to read valid protected release evidence from --proof.');
    }
  }
  try {
    const result = await serviceJson(
      `${auth.serviceUrl}/v1/billing-accounts/catalog${action === 'activate' ? '/activate' : ''}`,
      auth.token,
      action === 'activate'
        ? {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }
        : {},
      fetchImpl,
    );
    const parsed =
      action === 'activate'
        ? BillingCatalogActivationClientResponseSchema.parse(result)
        : BillingCatalogStatusClientResponseSchema.parse(result);
    if (args.json) printJsonOk(parsed.data);
    else
      console.log(
        `Billing catalog ${parsed.data.version}; ${action === 'activate' ? 'release activation verified' : 'reader 2 supported'}.`,
      );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'billing catalog',
      serviceFailure('billing catalog', error, 'noodle billing catalog status'),
      args.json,
    );
  }
}
