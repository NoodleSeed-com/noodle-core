import {
  SolutionInstallationOptionsClientResponseSchema,
  SolutionInstallationOptionsQuerySchema,
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

export async function runSolutionInstallationOptions(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = 'solutions installation-options';
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--limit': 'limit',
      '--cursor': 'cursor',
    },
    booleans: { '--json': 'json' },
  });
  const parsed = SolutionInstallationOptionsQuerySchema.safeParse({
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (args.parseError || args.positional.length || !parsed.success)
    return printCliFailure(
      command,
      usageError(
        args.parseError ?? 'Use a limit from 1 to 100 and an opaque cursor from the previous page.',
        'noodle solutions installation-options [--limit <1-100>] [--cursor <cursor>] [--json]',
      ),
      args.json,
    );
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  const query = new URLSearchParams({ limit: String(parsed.data.limit) });
  if (parsed.data.cursor) query.set('cursor', parsed.data.cursor);
  try {
    const result = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/me/solution-installation-options?${query}`,
      resolved.token,
      {},
      options.fetchImpl ?? fetch,
    );
    const data = SolutionInstallationOptionsClientResponseSchema.parse(result).data;
    if (args.json) printJsonOk(data);
    else
      console.log(
        [
          ...data.organizations.map(
            (org) => `${org.slug}${org.displayName ? ` — ${org.displayName}` : ''}`,
          ),
          ...(data.organizations.length === 0
            ? ['No organization permits installation for this account.']
            : []),
          ...(data.nextCursor ? [`Next cursor: ${data.nextCursor}`] : []),
        ].join('\n'),
      );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      command,
      serviceFailure(command, error, 'noodle solutions installation-options'),
      args.json,
    );
  }
}
