import { readFileSync, statSync } from 'node:fs';
import {
  type CapabilityListResponse,
  capabilityPolicyUpdateSchema,
  capabilityTestRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { renderTable } from '../table.js';
import { EXIT, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import { parseCommandFlags, printCliFailure } from './shared.js';

export function parseCapabilityArgs(rest: readonly string[]) {
  return parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--policy-file': 'policyFile',
      '--expected-revision': 'expectedRevision',
      '--mutation-id': 'mutationId',
      '--request-file': 'requestFile',
      '--mode': 'mode',
    },
    booleans: { '--json': 'json' },
  });
}
export async function runCapabilities(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const args = parseCapabilityArgs(rest);
  const [action, name] = args.positional;
  const failure = (code: string, message: string, exitCode: number) =>
    printCliFailure(
      'capabilities',
      {
        code,
        message,
        cause: 'The capability operation was not completed.',
        fix: 'Inspect the exact app/environment and correct the request before retrying.',
        next: 'noodle capabilities inspect --org <org> --app <app> --env <env>',
        exitCode,
      },
      args.json,
    );
  if (
    args.parseError ||
    args.positional.length > 2 ||
    !['inspect', 'configure', 'test'].includes(action ?? '') ||
    !args.org ||
    !args.app ||
    !args.targetEnv ||
    (action !== 'inspect' && !name)
  ) {
    return failure(
      'usage',
      args.parseError ?? 'Specify inspect, configure, or test and exact --org, --app, --env.',
      EXIT.USAGE,
    );
  }
  let body: unknown;
  try {
    if (action === 'configure') {
      if (
        !args.policyFile ||
        args.expectedRevision === undefined ||
        !args.mutationId ||
        !/^\d+$/.test(args.expectedRevision)
      )
        throw new Error('missing configuration');
      body = capabilityPolicyUpdateSchema.parse({
        expectedRevision: Number(args.expectedRevision),
        mutationId: args.mutationId,
        policy: readJson(args.policyFile),
      });
    }
    if (action === 'test') {
      if (!args.requestFile) throw new Error('missing request');
      body = capabilityTestRequestSchema.parse({
        mode: args.mode,
        request: readJson(args.requestFile),
      });
    }
  } catch {
    return failure(
      'invalid_request',
      'Use a valid bounded JSON file, explicit revision/mutation ID for configure, or --mode fixture|live for test.',
      EXIT.USAGE,
    );
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  const local = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(resolved.serviceUrl);
  if (resolved.token === undefined && !local)
    return failure('auth_required', 'Sign in to the hosted service with noodle login.', EXIT.AUTH);
  const base =
    resolved.serviceUrl +
    '/v1/orgs/' +
    encodeURIComponent(args.org) +
    '/apps/' +
    encodeURIComponent(args.app) +
    '/envs/' +
    encodeURIComponent(args.targetEnv) +
    '/capabilities';
  const suffix =
    name === undefined
      ? ''
      : '/' +
        encodeURIComponent(name) +
        (action === 'configure' ? '/policy' : action === 'test' ? '/test' : '');
  try {
    const response = await serviceJson<unknown>(
      base + suffix,
      resolved.token ?? '',
      action === 'inspect'
        ? {}
        : {
            method: action === 'configure' ? 'PUT' : 'POST',
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          },
      options.fetchImpl ?? fetch,
      { timeoutMs: 35_000 },
    );
    if (args.json) printJsonOk(response);
    else if (action === 'inspect' && name === undefined) {
      type Row = CapabilityListResponse['capabilities'][number];
      console.log(
        renderTable(
          [
            { header: 'Name', get: (r: Row) => r.name },
            { header: 'Available', get: (r: Row) => (r.available ? 'yes' : 'no') },
            { header: 'Revision', get: (r: Row) => String(r.revision) },
            { header: 'Profile', get: (r: Row) => r.profile },
          ],
          (response as CapabilityListResponse).capabilities,
          stdoutTableOptions(),
        ),
      );
    } else printRawJsonForHumanDebug(response, 2);
    return EXIT.OK;
  } catch (error) {
    return failure(
      error instanceof ServiceRequestError
        ? (error.code ?? 'service_error')
        : 'service_unreachable',
      error instanceof ServiceRequestError
        ? 'The service refused the capability operation.'
        : 'The capability service could not be reached.',
      EXIT.FAILURE,
    );
  }
}
function readJson(path: string): unknown {
  if (statSync(path).size > 16_384) throw new Error('file too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}
