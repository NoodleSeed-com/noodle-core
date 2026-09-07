import { validateJsonSchema } from '@noodle-borg/compiler';
import type { DevReloadResult, localMcpCall } from '../dev.js';
import {
  type EffectiveLocalTarget,
  type EffectiveLocalTargetResolution,
  UNLINKED_LOCAL_TARGET_HINT,
} from '../local-target.js';
import { EXIT, type JsonError, printJsonFailure } from './output.js';

function unresolvedNames(
  boot: DevReloadResult,
  code: 'missing_secret' | 'missing_variable',
  prefix: 'secrets.' | 'variables.',
): string[] {
  if (boot.ok) return [];
  return [
    ...new Set(
      (boot.errors ?? [])
        .filter((error) => error.code === code)
        .map((error) =>
          error.path.startsWith(prefix) ? error.path.slice(prefix.length) : error.path,
        )
        .filter((name) => name.length > 0),
    ),
  ].sort();
}

function recoveryCommands(
  command: 'secrets' | 'variables',
  names: readonly string[],
  target: EffectiveLocalTarget,
  projectRoot?: string,
): string {
  const commands = names
    .map(
      (name) =>
        `noodle ${command} set ${name} --runtime local --scope env --org ${target.org} --app ${target.app} --env ${target.env} --from-env ${name}`,
    )
    .join(' && ');
  return projectRoot === undefined
    ? commands
    : `cd ${shellQuoteCommandArgument(projectRoot)} && ${commands}`;
}

function shellQuoteCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function localBootError(
  boot: DevReloadResult,
  resolution: EffectiveLocalTargetResolution,
  projectRoot?: string,
): JsonError | undefined {
  const target = resolution.target;
  const secrets = unresolvedNames(boot, 'missing_secret', 'secrets.');
  const variables = unresolvedNames(boot, 'missing_variable', 'variables.');
  if (secrets.length > 0) {
    return {
      code: 'connector_secret_unresolved',
      message: `required connector secret(s) not set for this local run: ${secrets.join(', ')}${variables.length ? `; required variable(s): ${variables.join(', ')}` : ''} — the server did not start.`,
      fix: [
        recoveryCommands('secrets', secrets, target, projectRoot),
        ...(variables.length ? [recoveryCommands('variables', variables, target)] : []),
      ].join(' && '),
      detail: { target, secrets, ...(variables.length ? { variables } : {}) },
      ...(resolution.ignoredSavedTarget ? { next: 'noodle link' } : {}),
    };
  }

  if (variables.length > 0) {
    return {
      code: 'variable_unresolved',
      message: `required variable(s) not set for this local run: ${variables.join(', ')} — a \`variable(...)\` could not be resolved, so the server did not start.`,
      fix: recoveryCommands('variables', variables, target, projectRoot),
      detail: { target, variables },
      ...(resolution.ignoredSavedTarget ? { next: 'noodle link' } : {}),
    };
  }
  if (!boot.ok) {
    return {
      code: 'local_boot_failed',
      message: 'The local server did not start; no MCP operation was attempted.',
      fix: 'Run local validation first, then inspect the remaining startup failure with noodle dev. Do not retry a business operation until the server is ready.',
      next: `${projectRoot === undefined ? '' : `cd ${shellQuoteCommandArgument(projectRoot)} && `}noodle validate --json`,
    };
  }
  return undefined;
}

type LocalMcpResponse = Awaited<ReturnType<typeof localMcpCall>>;
export type LocalSmokeMethod =
  | 'initialize'
  | 'tools/list'
  | 'tools/call'
  | 'resources/read'
  | 'prompts/get';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Classify completion without copying tool payloads, RPC text/data or continuation state into errors.
 * The SDK validates envelopes; the existing compiler validator checks the listed output contract.
 * A fresh localMcpCall client has no tools/list cache, so SDK output validation alone is insufficient. */
export function localMcpError(
  response: LocalMcpResponse,
  method: LocalSmokeMethod,
  outputSchema?: Record<string, unknown>,
): JsonError | undefined {
  const result = response.body?.result;
  let reason: string | undefined;
  if (response.status !== 200 || response.body?.error !== undefined) reason = 'rpc_error';
  else if (!record(result)) reason = 'invalid_result';
  else if (result.resultType === 'input_required') reason = 'input_required';
  else if (result.resultType !== undefined && result.resultType !== 'complete')
    reason = 'incomplete_result';
  else if (method === 'tools/call' && result.isError === true) reason = 'tool_error';
  else if (method === 'initialize' && typeof result.protocolVersion !== 'string')
    reason = 'invalid_result';
  else if (
    method === 'tools/list' &&
    (!Array.isArray(result.tools) ||
      result.tools.some((tool) => !record(tool) || typeof tool.name !== 'string'))
  )
    reason = 'invalid_result';
  else if (method === 'resources/read' && !Array.isArray(result.contents))
    reason = 'invalid_result';
  else if (method === 'prompts/get' && !Array.isArray(result.messages)) reason = 'invalid_result';
  else if (method === 'tools/call' && !Array.isArray(result.content)) reason = 'invalid_result';
  else if (
    method === 'tools/call' &&
    outputSchema &&
    validateJsonSchema(outputSchema, result.structuredContent).length > 0
  )
    reason = 'output_schema_mismatch';
  if (!reason) return undefined;
  const pending = reason === 'input_required';
  const rpc = response.body?.error;
  return {
    code: 'mcp_error',
    message: pending
      ? 'The local operation requires interactive input; completion is not verified.'
      : `Local ${method} did not prove successful completion (${reason}).`,
    next: pending ? 'noodle devtools' : 'noodle dev',
    fix: pending
      ? 'Use Devtools to inspect and approve the exact action; this smoke does not approve or resume it.'
      : 'Inspect the tool schema, effective local configuration and application behavior. Verify whether a write happened before retrying; a failed response does not prove rollback.',
    detail: {
      method,
      reason,
      status: response.status,
      ...(record(rpc) && typeof rpc.code === 'number' && Number.isFinite(rpc.code)
        ? { rpcCode: rpc.code }
        : {}),
    },
  };
}

export function reportLocalMcpFailure(error: JsonError, asJson: boolean): number {
  if (asJson) return printJsonFailure(error, EXIT.MCP);
  console.error(`✗ ${error.message}`);
  if (error.fix) console.error(`  fix: ${error.fix}`);
  return EXIT.MCP;
}

export function reportLocalBootFailure(
  boot: DevReloadResult,
  resolution: EffectiveLocalTargetResolution,
  asJson: boolean,
  projectRoot?: string,
): number | undefined {
  const error = localBootError(boot, resolution, projectRoot);
  if (error === undefined) return undefined;
  if (asJson) return printJsonFailure(error, EXIT.MCP);
  console.error(`✗ ${error.message}`);
  console.error(`  fix: ${error.fix}`);
  if (resolution.ignoredSavedTarget) console.error(`  ${UNLINKED_LOCAL_TARGET_HINT}`);
  return EXIT.MCP;
}
