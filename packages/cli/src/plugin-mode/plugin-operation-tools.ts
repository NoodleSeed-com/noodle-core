import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { normalizeDeployVersion } from '@noodle-borg/deploy-client';
import type { z } from 'zod';
import { bootstrapStatusSchema } from '../project-bootstrap-report.js';

import type {
  BuildCommandRequest,
  BuildCommandResult,
  BuildReadinessCommandRunner,
} from './plugin-command-runner.js';
import {
  CLOUD_MUTATION,
  type CloudTargetInput,
  feedbackPreviewInputSchema,
  feedbackSubmitInputSchema,
  LOCAL_MUTATION,
  linkInputSchema,
  operationFailure,
  operationResultSchema,
  operationSuccess,
  preflightDiagnosticsSchema,
  preflightInputSchema,
  preflightReportSchema,
  publicTargetFlags,
  READ_ONLY,
  secretInputSchema,
  setupInputSchema,
  targetData,
  targetFlags,
  variableInputSchema,
} from './plugin-operation-contract.js';

export {
  type CloudTargetInput,
  cloudTargetInputSchema,
} from './plugin-operation-contract.js';

const PLUGIN_SECRET_INPUT_ENVIRONMENT = 'NOODLE_PLUGIN_SECRET_INPUT';

interface OperationToolOptions {
  readonly server: McpServer;
  readonly runner: BuildReadinessCommandRunner;
  readonly workspaceRoot: string;
  readonly workspaceHandle: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly assertScope: (handle: string) => CallToolResult | undefined;
}

export function registerSetupProjectTool(options: OperationToolOptions): void {
  options.server.registerTool(
    'setup_project',
    {
      title: 'Set up Noodle project',
      description:
        'Initialize a project with pinned local dependencies and synthetic checks, or reconcile supported context files. Installation can access package registries; install=false prepares files only. Never launches another agent.',
      inputSchema: setupInputSchema,
      outputSchema: operationResultSchema,
      annotations: { ...LOCAL_MUTATION, openWorldHint: true },
    },
    async ({ workspaceHandle, mode, template, packageManager, install }) => {
      const denied = options.assertScope(workspaceHandle);
      if (denied !== undefined) return denied;
      const command = mode === 'initialize' ? 'init' : 'setup';
      const args =
        mode === 'initialize'
          ? [
              '.',
              ...(template ? ['--template', template] : []),
              ...(packageManager ? ['--package-manager', packageManager] : []),
              ...(install === false ? ['--no-install'] : []),
              '--json',
            ]
          : ['--write', '--json'];
      const publicCommand =
        mode === 'initialize' ? `noodle init ${args.join(' ')}` : 'noodle setup --write --json';
      const result = await runPublic(options, { command, args }, publicCommand);
      if (!result.ok) return result.failure;
      const setup =
        mode === 'initialize'
          ? bootstrapStatusSchema.safeParse(recordProperty(result.data, 'setup'))
          : undefined;
      if (setup && !setup.success)
        return operationFailure(
          'invalid_bootstrap_report',
          'Setup did not return verifiable progress.',
          publicCommand,
          publicCommand,
        );
      return operationSuccess(`Project ${mode} completed.`, {
        operation: mode,
        command: publicCommand,
        ...(setup?.success ? { setup: setup.data } : {}),
      });
    },
  );
}

export function registerCloudConfigurationTools(options: OperationToolOptions): void {
  options.server.registerTool(
    'preflight_build',
    {
      title: 'Inspect deployment readiness',
      description:
        'Check the authored project against an explicit hosted target using existing access. Does not link, configure, upload or publish; reports all available prerequisite findings.',
      inputSchema: preflightInputSchema,
      outputSchema: operationResultSchema,
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async (input) => {
      const denied = options.assertScope(input.workspaceHandle);
      if (denied !== undefined) return denied;
      const args = [
        'preflight',
        ...deployCommandArgs(input),
        ...(input.version === undefined ? [] : ['--version', input.version]),
      ];
      const command = `noodle deploy ${args.join(' ')}`;
      const result = await runPublic(options, { command: 'deploy', args }, command);
      if (!result.ok) return result.failure;
      const report = preflightReportSchema.safeParse(result.data);
      if (
        !report.success ||
        report.data.target.org !== input.org ||
        report.data.target.app !== input.app ||
        report.data.target.env !== input.environment ||
        (input.version !== undefined &&
          report.data.serverVersion !== normalizeDeployVersion(input.version))
      ) {
        return operationFailure(
          'invalid_preflight_report',
          'The command did not return consistent readiness for the requested target.',
          command,
          command,
        );
      }
      return operationSuccess(
        'Preflight ready. Nothing was published; backend operations and host behavior require separate verification.',
        {
          operation: 'preflight',
          command,
          target: targetData(input),
          preflight: report.data,
        },
      );
    },
  );

  options.server.registerTool(
    'link_cloud_project',
    {
      title: 'Link cloud project',
      description:
        'Validate live organization access, write one exact project link, and confirm the saved target.',
      inputSchema: linkInputSchema,
      outputSchema: operationResultSchema,
      annotations: CLOUD_MUTATION,
    },
    async (input) => {
      const denied = options.assertScope(input.workspaceHandle);
      if (denied !== undefined) return denied;
      const orgFailure = await validateOrganization(options, input);
      if (orgFailure !== undefined) return orgFailure;
      const args = [
        '--org',
        input.org,
        '--app',
        input.app,
        '--env',
        input.environment,
        ...(input.access === undefined ? [] : ['--access', input.access]),
      ];
      const publicCommand = `noodle link ${args.join(' ')}`;
      const linked = await runPublic(options, { command: 'link', args }, publicCommand);
      if (!linked.ok) return linked.failure;
      const targetFailure = await validateLinkedTarget(options, input);
      if (targetFailure !== undefined) return targetFailure;
      return operationSuccess('Cloud project linked and confirmed.', {
        operation: 'link',
        command: publicCommand,
        target: targetData(input),
      });
    },
  );

  options.server.registerTool(
    'set_cloud_variable',
    {
      title: 'Set cloud variable',
      description:
        'Validate login and the exact linked cloud target, then set one non-secret value through standard input.',
      inputSchema: variableInputSchema,
      outputSchema: operationResultSchema,
      annotations: CLOUD_MUTATION,
    },
    async (input) => {
      const denied = options.assertScope(input.workspaceHandle);
      if (denied !== undefined) return denied;
      const preflight = await validateCloudTarget(options, input);
      if (preflight !== undefined) return preflight;
      const args = ['set', input.name, ...targetFlags(input), '--from-stdin', '--json'];
      const publicCommand = `noodle variables set ${input.name} ${publicTargetFlags(input)} --from-stdin --json`;
      const result = await runPublic(
        options,
        { command: 'variables', args, stdin: input.value },
        publicCommand,
      );
      if (!result.ok) return result.failure;
      return operationSuccess('Cloud variable set.', {
        operation: 'set-variable',
        command: publicCommand,
        target: targetData(input),
        name: input.name,
      });
    },
  );

  options.server.registerTool(
    'set_cloud_secret_from_env',
    {
      title: 'Set cloud secret from environment',
      description:
        'Validate the exact linked cloud target and transfer one named environment value without accepting or returning its plaintext.',
      inputSchema: secretInputSchema,
      outputSchema: operationResultSchema,
      annotations: CLOUD_MUTATION,
    },
    async (input) => {
      const denied = options.assertScope(input.workspaceHandle);
      if (denied !== undefined) return denied;
      const publicCommand =
        `noodle secrets set ${input.name} ${publicTargetFlags(input)}` +
        ` --from-env ${input.sourceEnvironmentVariable} --json`;
      if (options.environment[input.sourceEnvironmentVariable] === undefined) {
        return operationFailure(
          'secret_source_missing',
          `Environment variable ${input.sourceEnvironmentVariable} is not available to the plugin.`,
          publicCommand,
        );
      }
      const preflight = await validateCloudTarget(options, input);
      if (preflight !== undefined) return preflight;
      const args = [
        'set',
        input.name,
        ...targetFlags(input),
        '--from-env',
        PLUGIN_SECRET_INPUT_ENVIRONMENT,
        '--json',
      ];
      const result = await runPublic(
        options,
        {
          command: 'secrets',
          args,
          forwardEnvironment: [
            {
              sourceName: input.sourceEnvironmentVariable,
              targetName: PLUGIN_SECRET_INPUT_ENVIRONMENT,
            },
          ],
        },
        publicCommand,
      );
      if (!result.ok) return result.failure;
      return operationSuccess('Cloud secret set from the named environment variable.', {
        operation: 'set-secret',
        command: publicCommand,
        target: targetData(input),
        name: input.name,
      });
    },
  );
}

export function registerFeedbackTools(options: OperationToolOptions): void {
  options.server.registerTool(
    'preview_product_feedback',
    {
      title: 'Preview product feedback',
      description:
        'Validate and preview a sanitized product-feedback submission without authentication or network access.',
      inputSchema: feedbackPreviewInputSchema,
      outputSchema: operationResultSchema,
      annotations: READ_ONLY,
    },
    async (input) => runFeedbackTool(options, input, true),
  );
  options.server.registerTool(
    'submit_product_feedback',
    {
      title: 'Submit approved product feedback',
      description:
        'Submit the exact sanitized feedback once, only after the caller supplies explicit approval.',
      inputSchema: feedbackSubmitInputSchema,
      outputSchema: operationResultSchema,
      annotations: CLOUD_MUTATION,
    },
    async (input) => runFeedbackTool(options, input, false),
  );
}

export async function validateCloudTarget(
  options: OperationToolOptions,
  target: CloudTargetInput,
): Promise<CallToolResult | undefined> {
  return (await validateOrganization(options, target)) ?? validateLinkedTarget(options, target);
}

export function publicDeployCommand(target: CloudTargetInput): string {
  return `noodle deploy --org ${target.org} --app ${target.app} --env ${target.environment} --json --no-prompt`;
}

export function deployCommandArgs(target: CloudTargetInput): readonly string[] {
  return [
    '--org',
    target.org,
    '--app',
    target.app,
    '--env',
    target.environment,
    '--json',
    '--no-prompt',
  ];
}

async function runFeedbackTool(
  options: OperationToolOptions,
  input: z.infer<typeof feedbackPreviewInputSchema>,
  dryRun: boolean,
): Promise<CallToolResult> {
  const denied = options.assertScope(input.workspaceHandle);
  if (denied !== undefined) return denied;
  const args = [
    '--message',
    input.message,
    ...(input.title === undefined ? [] : ['--title', input.title]),
    '--type',
    input.type,
    '--severity',
    input.severity,
    '--area',
    input.area,
    ...(dryRun ? ['--dry-run'] : []),
    '--json',
  ];
  const publicCommand = dryRun ? 'noodle feedback --dry-run --json' : 'noodle feedback --json';
  const result = await runPublic(options, { command: 'feedback', args }, publicCommand);
  if (!result.ok) return result.failure;
  const reference = stringProperty(result.data, 'reference');
  return operationSuccess(
    dryRun ? 'Product feedback preview is ready.' : 'Product feedback submitted.',
    {
      operation: dryRun ? 'preview-feedback' : 'submit-feedback',
      command: publicCommand,
      ...(reference === undefined ? {} : { reference }),
    },
  );
}

async function validateOrganization(
  options: OperationToolOptions,
  target: CloudTargetInput,
): Promise<CallToolResult | undefined> {
  const command = 'noodle orgs list --json';
  const result = await runPublic(options, { command: 'orgs', args: ['list', '--json'] }, command);
  if (!result.ok) return result.failure;
  const orgs = recordProperty(result.data, 'orgs');
  const available =
    Array.isArray(orgs) &&
    orgs.some((org) => org !== null && typeof org === 'object' && org.slug === target.org);
  return available
    ? undefined
    : operationFailure(
        'organization_not_available',
        `The signed-in identity cannot use organization ${target.org}.`,
        command,
        command,
      );
}

async function validateLinkedTarget(
  options: OperationToolOptions,
  target: CloudTargetInput,
): Promise<CallToolResult | undefined> {
  const command = 'noodle target show --json';
  const result = await runPublic(options, { command: 'target', args: ['show', '--json'] }, command);
  if (!result.ok) return result.failure;
  const view = recordProperty(result.data, 'target');
  const exact =
    linkedField(view, 'org') === target.org &&
    linkedField(view, 'app') === target.app &&
    linkedField(view, 'env') === target.environment;
  return exact
    ? undefined
    : operationFailure(
        'target_mismatch',
        `The linked target does not match ${target.org}/${target.app}/${target.environment}.`,
        command,
        `noodle link --org ${target.org} --app ${target.app} --env ${target.environment}`,
      );
}

function linkedField(value: unknown, name: string): string | undefined {
  const field = recordProperty(value, name);
  if (recordProperty(field, 'source') !== 'link') return undefined;
  const resolved = recordProperty(field, 'value');
  return typeof resolved === 'string' ? resolved : undefined;
}

async function runPublic(
  options: OperationToolOptions,
  request: Pick<BuildCommandRequest, 'command' | 'args' | 'stdin' | 'forwardEnvironment'>,
  publicCommand: string,
): Promise<
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly failure: CallToolResult }
> {
  let result: BuildCommandResult;
  try {
    result = await options.runner.run({
      ...request,
      cwd: options.workspaceRoot,
      workspaceHandle: options.workspaceHandle,
    });
  } catch {
    return {
      ok: false,
      failure: operationFailure(
        'public_command_unavailable',
        'The public Noodle command could not be started.',
        publicCommand,
        publicCommand,
      ),
    };
  }
  const envelope = parseEnvelope(result.stdout);
  if (
    result.exitCode === 0 &&
    (!request.args.includes('--json') || recordProperty(envelope, 'ok') === true)
  ) {
    return { ok: true, data: recordProperty(envelope, 'data') };
  }
  const error = recordProperty(envelope, 'error');
  if (request.command === 'init') {
    const setup = bootstrapStatusSchema.safeParse(
      recordProperty(recordProperty(error, 'detail'), 'setup'),
    );
    return {
      ok: false,
      failure: operationFailure(
        'bootstrap_failed',
        'Local setup did not complete; inspect the reported stage and resume the public command.',
        publicCommand,
        publicCommand,
        setup.success ? setup.data : undefined,
      ),
    };
  }
  const code = stringProperty(error, 'code') ?? 'public_command_failed';
  const message =
    safeErrorMessage(stringProperty(error, 'message')) ??
    'The public Noodle command did not complete successfully.';
  const upstreamNext = stringProperty(error, 'next');
  const next = upstreamNext?.startsWith('noodle ') ? upstreamNext : publicCommand;
  const detail = recordProperty(error, 'detail');
  const preflight =
    request.command === 'deploy' && request.args[0] === 'preflight'
      ? preflightDiagnosticsSchema.safeParse({
          missingSecrets: recordProperty(detail, 'missingSecrets'),
          missingVariables: recordProperty(detail, 'missingVariables'),
          actions: recordProperty(detail, 'actions'),
          errors: recordProperty(error, 'errors'),
        })
      : undefined;
  return {
    ok: false,
    failure: operationFailure(
      code,
      message,
      publicCommand,
      next,
      undefined,
      preflight?.success ? preflight.data : undefined,
    ),
  };
}

function parseEnvelope(stdout: string): unknown {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Keep looking for the final bounded JSON envelope.
    }
  }
  return undefined;
}

function recordProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = recordProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

function safeErrorMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/noodle-plugin(?:-cursor)?\.mjs|plugin-cache/i.test(value)) return undefined;
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}
