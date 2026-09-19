import {
  BusinessPageClientResponseSchema,
  BusinessPageContentSchema,
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

export async function runSolutionPage(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  location: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = 'solutions page';
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--org': 'org',
      '--expected-revision': 'revision',
      '--data': 'data',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const [operation, installation, ...extra] = args.positional;
  const invalid = (message: string) =>
    printCliFailure(
      command,
      usageError(
        message,
        'noodle solutions page <show|save|publish|unpublish> <installation> --org <org> [--expected-revision <n>] [--data <json>] [--confirm] [--json]',
      ),
      args.json,
    );
  if (
    args.parseError ||
    !operation ||
    !['show', 'save', 'publish', 'unpublish'].includes(operation) ||
    !installation ||
    !args.org ||
    extra.length
  )
    return invalid(
      args.parseError ?? 'Supply an operation, installation and explicit organization.',
    );
  if (
    (operation !== 'save' && args.data !== undefined) ||
    (operation === 'show' && args.revision !== undefined) ||
    (['show', 'save'].includes(operation) && args.confirm)
  )
    return invalid('A flag does not apply to this operation.');
  const expectedRevision = Number(args.revision);
  if (
    operation !== 'show' &&
    (!/^\d{1,10}$/.test(args.revision ?? '') ||
      expectedRevision < (operation === 'save' ? 0 : 1) ||
      expectedRevision > 2_147_483_647)
  )
    return invalid('--expected-revision must identify the current saved revision.');
  if (['publish', 'unpublish'].includes(operation) && !args.confirm)
    return invalid('--confirm is required to change public availability.');
  let content: typeof BusinessPageContentSchema._output | undefined;
  if (operation === 'save') {
    try {
      if (!args.data || Buffer.byteLength(args.data, 'utf8') > 256 * 1024)
        return invalid('--data must contain bounded page content JSON.');
      const parsed = BusinessPageContentSchema.safeParse(JSON.parse(args.data));
      if (!parsed.success)
        return invalid(
          'Page content must contain an introduction and up to eight plain-text sections.',
        );
      content = parsed.data;
    } catch {
      return invalid('--data must contain valid page content JSON.');
    }
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home: location,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  const suffix = ['publish', 'unpublish'].includes(operation) ? `/${operation}` : '';
  const url = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/page${suffix}`;
  try {
    const result = await serviceJson<unknown>(
      url,
      resolved.token,
      {
        method: operation === 'show' ? 'GET' : operation === 'save' ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(operation === 'show'
          ? {}
          : {
              body: JSON.stringify(
                operation === 'save' ? { expectedRevision, content } : { expectedRevision },
              ),
            }),
      },
      options.fetchImpl ?? fetch,
    );
    const parsed = BusinessPageClientResponseSchema.safeParse(result);
    if (!parsed.success) throw new Error('The service returned an invalid page response.');
    if (args.json) printJsonOk(parsed.data.data);
    else
      console.log(
        `Page revision ${parsed.data.data.revision} · ${parsed.data.data.published ? 'published snapshot saved' : 'not published'}`,
      );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      command,
      serviceFailure(command, error, 'noodle solutions page --help'),
      args.json,
    );
  }
}
