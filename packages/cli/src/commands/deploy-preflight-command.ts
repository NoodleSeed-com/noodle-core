import { findCommand } from './catalog.js';
import { deployResumeCommand } from './deploy-first-flow.js';
import { type HostedDeployPreflightInput, preflightHostedDeploy } from './deploy-preflight.js';
import { preflightBlocked, preflightError } from './deploy-preflight-output.js';
import { EXIT, printJsonOk } from './output.js';
import { printCliFailure, usageError } from './shared.js';

/** Validate the read-only command against its canonical catalog before resolving credentials. */
export function validateDeployPreflightArgs(rest: readonly string[]): number | undefined {
  const spec = findCommand('deploy')?.subcommands?.find((item) => item.name === 'preflight');
  if (spec === undefined) throw new Error('deploy preflight catalog is missing');
  const seen = new Set<string>();
  let positional = 0;
  let message: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('-')) {
      if (++positional > 1) message = 'deploy preflight accepts at most one entrypoint';
      continue;
    }
    const flag = spec.flags.find((item) => `--${item.name}` === arg);
    if (flag === undefined) {
      message = `unknown option: ${arg}`;
      break;
    }
    if (seen.has(arg)) {
      message = `${arg} may be supplied once`;
      break;
    }
    seen.add(arg);
    if (flag.type !== 'boolean') {
      const value = rest[++index];
      if (value === undefined || value.startsWith('--')) {
        message = `${arg} requires a value`;
        break;
      }
    }
  }
  return message === undefined
    ? undefined
    : printCliFailure(
        'deploy preflight',
        usageError(message, 'noodle deploy preflight --help'),
        rest.includes('--json'),
      );
}

/** Reuse deploy's compiler and service check, but never configure, checkpoint, upload or publish. */
export async function runDeployPreflight(
  input: HostedDeployPreflightInput & { readonly json: boolean },
): Promise<number> {
  const resume = deployResumeCommand({
    ...input,
    accessMode: input.accessMode ?? 'owner-only',
    noPrompt: true,
  });
  try {
    const { response } = await preflightHostedDeploy(input);
    if (!response.ready) {
      if (!input.json) console.error('No deployment was created. Preflight found these blockers:');
      return preflightBlocked(
        response,
        input.target,
        input.serverVersion,
        resume,
        input.json,
        false,
      ).exitCode;
    }
    if (input.json)
      printJsonOk({
        ...response,
        published: false,
        serverVersion: input.serverVersion,
        next: resume,
      });
    else {
      console.log(
        `Preflight ready: ${input.target.org}/${input.target.app}/${input.target.env} version ${input.serverVersion}`,
      );
      console.log(
        'No deployment was created. Backend operations, uploaded assets and host behavior still require separate verification.',
      );
      console.log(`Next (publishes only when authorized): ${resume}`);
    }
    return EXIT.OK;
  } catch (error) {
    return preflightError(error, input.serviceUrl, input.target, input.json, false).exitCode;
  }
}
