import {
  BusinessWorkspaceAcceptRequestSchema,
  BusinessWorkspaceClientResponseSchema,
  BusinessWorkspaceInvitationRequestSchema,
  BusinessWorkspaceIssuedInvitationClientResponseSchema,
  BusinessWorkspaceMutationClientResponseSchema,
  BusinessWorkspaceRevisionRequestSchema,
  BusinessWorkspaceRoleChangeRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

const operationFlags: Readonly<Record<string, readonly string[]>> = {
  show: [],
  invite: ['email', 'role', 'revision'],
  'set-role': ['subject', 'role', 'revision', 'confirm'],
  remove: ['subject', 'revision', 'confirm'],
  'revoke-invitation': ['invitation', 'revision', 'confirm'],
  accept: ['tokenEnv', 'confirm'],
};
export async function runSolutionWorkspace(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch },
): Promise<number> {
  const command = 'solutions workspace';
  const args = parseCommandFlags(rest, {
    values: {
      '--service': 'service',
      '--auth-token': 'authToken',
      '--org': 'org',
      '--email': 'email',
      '--role': 'role',
      '--subject': 'subject',
      '--expected-revision': 'revision',
      '--invitation': 'invitation',
      '--token-from-env': 'tokenEnv',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const invalid = (message: string) =>
    printCliFailure(
      command,
      usageError(
        message,
        'noodle solutions workspace <show|invite|set-role|remove|revoke-invitation|accept> --org <org> [options] [--json]',
      ),
      args.json,
    );
  const [operation, ...extra] = args.positional;
  if (
    args.parseError ||
    !operation ||
    !operationFlags[operation] ||
    extra.length ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(args.org ?? '')
  )
    return invalid('Supply a workspace operation and explicit --org.');
  for (const key of [
    'email',
    'role',
    'subject',
    'revision',
    'invitation',
    'tokenEnv',
    'confirm',
  ] as const)
    if (args[key] && !operationFlags[operation].includes(key))
      return invalid('A flag does not apply to this operation.');
  if (!['show', 'invite'].includes(operation) && !args.confirm)
    return invalid('--confirm is required for this workspace change.');
  if (!['show', 'accept'].includes(operation) && !/^[1-9]\d{0,9}$/.test(args.revision ?? ''))
    return invalid('--expected-revision must identify the current workspace revision.');
  const expectedRevision = Number(args.revision);
  let body: unknown;
  let suffix = '',
    method = 'GET';
  if (operation === 'invite') {
    const input = BusinessWorkspaceInvitationRequestSchema.safeParse({
      email: args.email,
      expectedRevision,
      ...(args.role === undefined ? {} : { role: args.role }),
    });
    if (!input.success) return invalid('Supply a valid email, fixed role and expected revision.');
    body = input.data;
    suffix = '/invitations';
    method = 'POST';
  } else if (operation === 'set-role' || operation === 'remove') {
    const input = BusinessWorkspaceRoleChangeRequestSchema.safeParse({
      subject: args.subject,
      expectedRevision,
      role: operation === 'remove' ? null : args.role,
    });
    if (!input.success)
      return invalid('Supply a member subject, fixed role and expected revision.');
    body = input.data;
    suffix = '/members';
    method = 'PATCH';
  } else if (operation === 'revoke-invitation') {
    const input = BusinessWorkspaceRevisionRequestSchema.safeParse({ expectedRevision });
    if (
      !input.success ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.invitation ?? '')
    )
      return invalid('Supply --invitation <id> and the expected revision.');
    body = input.data;
    suffix = `/invitations/${args.invitation}`;
    method = 'DELETE';
  } else if (operation === 'accept') {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(args.tokenEnv ?? ''))
      return invalid(
        'Supply --token-from-env <NAME>; do not place the invitation token on the command line.',
      );
    const input = BusinessWorkspaceAcceptRequestSchema.safeParse({
      token: env[args.tokenEnv ?? ''],
    });
    if (!input.success)
      return invalid('The selected environment variable must contain a valid invitation token.');
    body = input.data;
    suffix = '/accept';
    method = 'POST';
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure(command, authRequired(), args.json);
  try {
    const response = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org ?? '')}/business-workspace${suffix}`,
      resolved.token,
      {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      options.fetchImpl ?? fetch,
    );
    const schema =
      operation === 'show'
        ? BusinessWorkspaceClientResponseSchema
        : operation === 'invite'
          ? BusinessWorkspaceIssuedInvitationClientResponseSchema
          : BusinessWorkspaceMutationClientResponseSchema;
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new Error('The service returned an invalid workspace response.');
    if (args.json) printJsonOk(parsed.data.data);
    else printRawJsonForHumanDebug(parsed.data.data, 2);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      command,
      serviceFailure(command, error, 'noodle solutions workspace --help'),
      args.json,
    );
  }
}
