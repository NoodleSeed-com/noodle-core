import {
  ApplicationConnectionsClientResponseSchema,
  type SolutionInstallationResponse,
} from '@noodle-borg/wire-contracts';
import { presentUrl, type UrlOpener } from '../browser.js';
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

export async function runSolutionConnections(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch; readonly open?: UrlOpener } = {},
): Promise<number> {
  const args = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--expected-revision': 'expectedRevision',
      '--portal': 'portal',
    },
    booleans: { '--json': 'json', '--no-open': 'noOpen' },
  });
  const [action, installationId, connectionId] = args.positional;
  const fail = (message: string) =>
    printCliFailure(
      'solutions connections',
      usageError(
        message,
        'noodle solutions connections <list|connect|disconnect> <installation> [connection] --org <org>',
      ),
      args.json,
    );
  if (args.parseError) return fail(args.parseError);
  if (
    !['list', 'connect', 'disconnect'].includes(action ?? '') ||
    !installationId ||
    !args.org ||
    args.positional.length > 3
  )
    return fail('An action, installation and --org are required.');
  if (action === 'disconnect' && !connectionId)
    return fail('A connection is required for disconnect.');
  if (action !== 'disconnect' && connectionId)
    return fail('Only disconnect accepts a connection identifier.');
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure('solutions connections', authRequired(), args.json);
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installationId)}`;
  try {
    if (action === 'connect') {
      const installation = await serviceJson<SolutionInstallationResponse>(
        base,
        resolved.token,
        {},
        fetchImpl,
      );
      const portal = new URL(
        args.portal ?? env.NOODLE_PORTAL_URL ?? 'https://portal.noodleseed.com',
      );
      if (
        portal.origin !== portal.href.replace(/\/$/, '') ||
        (portal.protocol !== 'https:' &&
          !(
            portal.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(portal.hostname)
          ))
      )
        return fail('--portal must be an HTTPS origin or explicit loopback HTTP origin.');
      const url = new URL(
        `/o/${encodeURIComponent(args.org)}/${encodeURIComponent(installation.data.installation.appSlug)}/integrations`,
        portal,
      ).href;
      const instruction =
        'Sign in to Portal as the same operator, choose Connect, and approve the provider account. Then run connections list to check availability.';
      if (args.json)
        printJsonOk({ portalUrl: url, status: 'browser_consent_required', instruction });
      else {
        console.log(instruction);
        await presentUrl(url, {
          shouldOpen: !args.noOpen,
          ...(options.open === undefined ? {} : { open: options.open }),
        });
      }
      return EXIT.OK;
    }
    const expectedRevision = Number(args.expectedRevision);
    if (
      action === 'disconnect' &&
      (args.expectedRevision === undefined ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0)
    )
      return fail('--expected-revision must be a non-negative integer.');
    const response = await serviceJson<unknown>(
      `${base}/connections${action === 'disconnect' ? `/${encodeURIComponent(connectionId ?? '')}/disconnect` : ''}`,
      resolved.token,
      action === 'disconnect'
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision }),
          }
        : {},
      fetchImpl,
    );
    const data = ApplicationConnectionsClientResponseSchema.parse(response).data;
    if (args.json) printJsonOk(data);
    else
      console.log(
        data.connections
          .map(
            (connection) =>
              `${connection.id}: ${connection.state} (revision ${connection.revision})`,
          )
          .join('\n') || 'No connections declared.',
      );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions connections',
      serviceFailure(
        'solutions connections',
        error,
        'noodle solutions connections list <installation> --org <org>',
      ),
      args.json,
    );
  }
}
