import { join } from 'node:path';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { transitionBuildRun } from './build-readiness-contract.js';
import { resolveWorkspaceIdentity } from './build-readiness-fingerprint.js';
import { BuildReadinessStore } from './build-readiness-store.js';
import {
  BUILD_GATE_COMMANDS,
  type BuildGateOperation,
  projectBuildReadiness,
} from './build-readiness-tools.js';
import {
  BUILD_READINESS_WIDGET_MIME_TYPE,
  BUILD_READINESS_WIDGET_URI,
  buildReadinessWidgetToolMeta,
  renderBuildReadinessWidget,
} from './build-readiness-widget.js';
import {
  type BuildCommandResult,
  type BuildReadinessCommandRunner,
  LocalCliBuildRunner,
} from './plugin-command-runner.js';
import {
  cloudTargetInputSchema,
  deployCommandArgs,
  publicDeployCommand,
  registerCloudConfigurationTools,
  registerFeedbackTools,
  registerSetupProjectTool,
  validateCloudTarget,
} from './plugin-operation-tools.js';
import type { PluginMode } from './profile.js';

export type {
  BuildCommandRequest,
  BuildCommandResult,
  BuildReadinessCommandRunner,
} from './plugin-command-runner.js';

export interface CreateBuildReadinessMcpServerOptions {
  readonly workspaceRoot: string;
  readonly pluginMode: PluginMode;
  readonly runner?: BuildReadinessCommandRunner;
  readonly cliEntrypoint?: string;
  readonly now?: () => Date;
  /** Test seam and the only source from which a named secret environment value may be forwarded. */
  readonly environment?: NodeJS.ProcessEnv;
}

const handleSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const runIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{22,128}$/);
const emptyInputSchema = z.strictObject({});
const workspaceInputSchema = z.strictObject({ workspaceHandle: handleSchema });
const gateInputSchema = z.strictObject({
  workspaceHandle: handleSchema,
  operation: z.enum(['validate', 'test', 'target-check', 'preview']),
});
const cancelInputSchema = z.strictObject({
  workspaceHandle: handleSchema,
  runId: runIdSchema,
});
const findingSchema = z.strictObject({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  relativePath: z.string().optional(),
  schemaPath: z.string().optional(),
});
const readinessDataSchema = z.strictObject({
  decision: z.enum(['action-required', 'running', 'ready-to-deploy', 'deployed', 'unavailable']),
  tone: z.enum(['ok', 'warn', 'error', 'neutral']),
  title: z.string(),
  summary: z.string(),
  workspaceHandle: handleSchema,
  sourceFingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  activeRunId: runIdSchema.optional(),
  stages: z.array(
    z.strictObject({
      id: z.enum(['project', 'validate', 'test', 'target-check', 'preview', 'deploy']),
      label: z.string(),
      status: z.enum([
        'not-run',
        'running',
        'passed',
        'failed',
        'cancelled',
        'interrupted',
        'stale',
      ]),
      tone: z.enum(['ok', 'warn', 'error', 'neutral']),
      runId: runIdSchema.optional(),
    }),
  ),
  findings: z.array(findingSchema).max(3),
  nextActions: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  actions: z.strictObject({
    validate: z.boolean(),
    test: z.boolean(),
    targetCheck: z.boolean(),
    preview: z.boolean(),
    deploy: z.boolean(),
    cancel: z.boolean(),
  }),
});
const contextDataSchema = z.strictObject({
  workspaceHandle: handleSchema,
  capabilities: z.strictObject({
    widgets: z.boolean(),
    tasks: z.boolean(),
    subscriptions: z.boolean(),
  }),
});
const cancelDataSchema = z.strictObject({ cancelled: z.literal(true), runId: runIdSchema });

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const LOCAL_MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const CLOUD_MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function createBuildReadinessMcpServer(
  options: CreateBuildReadinessMcpServerOptions,
): McpServer {
  const now = options.now ?? (() => new Date());
  const identity = resolveWorkspaceIdentity(options.workspaceRoot);
  const store = new BuildReadinessStore(join(options.pluginMode.configHome, 'build-readiness'));
  const runner =
    options.runner ??
    new LocalCliBuildRunner({
      cliEntrypoint: requiredEntrypoint(options.cliEntrypoint),
      pluginMode: options.pluginMode,
      sourceEnvironment: options.environment ?? process.env,
    });
  const server = new McpServer(
    { name: 'noodle-build-readiness', version: '1' },
    {
      instructions:
        'Operate the current Noodle project through typed plugin functions. Report only stable public noodle commands as recovery text.',
    },
  );

  const readiness = () =>
    projectBuildReadiness({
      store,
      workspaceRoot: options.workspaceRoot,
      workspaceHandle: identity.workspaceHandle,
      now: now(),
    });
  const assertScope = (handle: string): CallToolResult | undefined =>
    handle === identity.workspaceHandle
      ? undefined
      : failure('workspace_out_of_scope', 'The workspace handle is outside this local MCP scope.');
  const operationOptions = {
    server,
    runner,
    workspaceRoot: options.workspaceRoot,
    workspaceHandle: identity.workspaceHandle,
    environment: options.environment ?? process.env,
    assertScope,
  };

  server.registerTool(
    'get_local_context',
    {
      title: 'Get local Noodle context',
      description: 'Resolve the current local project to an opaque workspace handle.',
      inputSchema: emptyInputSchema,
      outputSchema: resultSchema(contextDataSchema),
      annotations: READ_ONLY,
    },
    async () =>
      success('Local Noodle project resolved.', {
        workspaceHandle: identity.workspaceHandle,
        capabilities: { widgets: true, tasks: false, subscriptions: false },
      }),
  );

  registerSetupProjectTool(operationOptions);

  server.registerTool(
    'get_build_readiness',
    {
      title: 'Get build readiness',
      description: 'Return the current decision, bounded stages, findings, and valid next actions.',
      inputSchema: workspaceInputSchema,
      outputSchema: resultSchema(readinessDataSchema),
      annotations: READ_ONLY,
      _meta: buildReadinessWidgetToolMeta(),
    },
    async ({ workspaceHandle }) => {
      const denied = assertScope(workspaceHandle);
      return denied ?? successFromReadiness(await readiness());
    },
  );

  server.registerTool(
    'run_build_gate',
    {
      title: 'Run a build gate',
      description: 'Run one allowlisted local gate for the current source fingerprint.',
      inputSchema: gateInputSchema,
      outputSchema: resultSchema(readinessDataSchema),
      annotations: LOCAL_MUTATION,
    },
    async ({ workspaceHandle, operation }) => {
      const denied = assertScope(workspaceHandle);
      if (denied !== undefined) return denied;
      const fixed = BUILD_GATE_COMMANDS[operation as BuildGateOperation];
      const command = `noodle ${fixed.command} ${fixed.args.join(' ')}`;
      let result: BuildCommandResult;
      try {
        result = await runner.run({
          command: fixed.command,
          args: fixed.args,
          cwd: options.workspaceRoot,
          workspaceHandle,
        });
      } catch {
        return failure(
          'public_command_unavailable',
          'The public Noodle command could not be started.',
          await readiness(),
          command,
          command,
        );
      }
      const view = await readiness();
      return result.exitCode === 0
        ? successFromReadiness(view)
        : failure(
            'build_gate_failed',
            `${fixed.command} exited with code ${result.exitCode}.`,
            view,
            command,
          );
    },
  );

  registerCloudConfigurationTools(operationOptions);

  server.registerTool(
    'deploy_build',
    {
      title: 'Deploy verified build',
      description: 'Deploy only after required gates pass for the current source fingerprint.',
      inputSchema: cloudTargetInputSchema,
      outputSchema: resultSchema(readinessDataSchema),
      annotations: CLOUD_MUTATION,
    },
    async (input) => {
      const { workspaceHandle } = input;
      const denied = assertScope(workspaceHandle);
      if (denied !== undefined) return denied;
      const command = publicDeployCommand(input);
      const before = await readiness();
      if (before.decision !== 'ready-to-deploy') {
        return failure(
          'build_not_ready',
          'Required gates have not passed for this source.',
          before,
          command,
          'noodle validate --json',
        );
      }
      const preflight = await validateCloudTarget(operationOptions, input);
      if (preflight !== undefined) return preflight;
      let result: BuildCommandResult;
      try {
        result = await runner.run({
          command: 'deploy',
          args: deployCommandArgs(input),
          cwd: options.workspaceRoot,
          workspaceHandle,
        });
      } catch {
        return failure(
          'public_command_unavailable',
          'The public Noodle command could not be started.',
          await readiness(),
          command,
          command,
        );
      }
      const after = await readiness();
      if (result.exitCode === 0) return successFromReadiness(after);
      const cliFailure = parseDeployFailure(result.stdout);
      return failure(
        cliFailure?.code ?? 'deploy_failed',
        cliFailure?.message ?? `deploy exited with code ${result.exitCode}.`,
        after,
        command,
        cliFailure?.next ?? command,
        cliFailure === undefined
          ? undefined
          : {
              ...(cliFailure.recoveryCommands !== undefined
                ? { recoveryCommands: cliFailure.recoveryCommands }
                : {}),
              ...(cliFailure.resume !== undefined ? { resume: cliFailure.resume } : {}),
            },
      );
    },
  );

  registerFeedbackTools(operationOptions);

  server.registerTool(
    'cancel_build_run',
    {
      title: 'Cancel active build run',
      description: 'Request cancellation of the exact active run in this workspace.',
      inputSchema: cancelInputSchema,
      outputSchema: resultSchema(cancelDataSchema),
      annotations: LOCAL_MUTATION,
    },
    async ({ workspaceHandle, runId }) => {
      const denied = assertScope(workspaceHandle);
      if (denied !== undefined) return denied;
      const snapshot = await store.read(workspaceHandle);
      const active = snapshot?.runs.find(
        (run) => run.runId === runId && (run.status === 'queued' || run.status === 'running'),
      );
      if (active === undefined) {
        return failure('run_not_active', 'The named run is not active in this workspace.');
      }
      if (!(await runner.cancel(runId))) {
        return failure('cancel_failed', 'The managed process did not accept cancellation.');
      }
      const finishedAt = now().toISOString();
      await store.mutate(workspaceHandle, (current) => {
        if (current === undefined) throw new Error('build readiness state disappeared');
        return {
          ...current,
          updatedAt: finishedAt,
          runs: current.runs.map((run) =>
            run.runId === runId
              ? transitionBuildRun(run, {
                  status: 'cancelled',
                  heartbeatAt: finishedAt,
                  finishedAt,
                })
              : run,
          ),
        };
      });
      return success('Build run cancelled.', { cancelled: true, runId });
    },
  );

  const widget = renderBuildReadinessWidget();
  server.registerResource(
    'noodle-build-readiness-widget',
    BUILD_READINESS_WIDGET_URI,
    {
      title: 'Noodle build readiness',
      description: 'A decision-first local build readiness interface.',
      mimeType: BUILD_READINESS_WIDGET_MIME_TYPE,
      _meta: widget._meta,
    },
    async () => ({
      contents: [
        {
          uri: widget.uri,
          mimeType: widget.mimeType,
          text: widget.text,
          _meta: widget._meta,
        },
      ],
    }),
  );

  return server;
}

export async function runBuildReadinessStdio(
  options: Omit<CreateBuildReadinessMcpServerOptions, 'runner'>,
): Promise<void> {
  serveStdio(() => createBuildReadinessMcpServer(options), { legacy: 'serve' });
}

function requiredEntrypoint(entrypoint: string | undefined): string {
  if (entrypoint === undefined)
    throw new Error('The plugin MCP requires its pinned CLI entrypoint.');
  return entrypoint;
}

function resultSchema<Data extends z.ZodType>(data: Data) {
  return z
    .strictObject({
      ok: z.boolean(),
      data: data.optional(),
      error: z
        .strictObject({
          code: z.string(),
          message: z.string(),
          command: z.string().optional(),
          next: z.string().optional(),
          recoveryCommands: z.array(z.string()).max(32).optional(),
          resume: z.string().optional(),
        })
        .optional(),
    })
    .superRefine((value, context) => {
      if (value.ok && value.data === undefined)
        context.addIssue({ code: 'custom', path: ['data'], message: 'success requires data' });
      if (!value.ok && value.error === undefined)
        context.addIssue({ code: 'custom', path: ['error'], message: 'failure requires error' });
    });
}

function successFromReadiness(
  data: Awaited<ReturnType<typeof projectBuildReadiness>>,
): CallToolResult {
  return success(data.summary, data);
}

function success(message: string, data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: true, data } as Record<string, unknown>,
  };
}

function failure(
  code: string,
  message: string,
  data?: unknown,
  command?: string,
  next?: string,
  recovery?: {
    readonly recoveryCommands?: readonly string[];
    readonly resume?: string;
  },
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: {
      ok: false,
      error: {
        code,
        message,
        ...(command === undefined ? {} : { command }),
        ...(next === undefined ? {} : { next }),
        ...(recovery?.recoveryCommands === undefined
          ? {}
          : { recoveryCommands: recovery.recoveryCommands }),
        ...(recovery?.resume === undefined ? {} : { resume: recovery.resume }),
      },
      ...(data === undefined ? {} : { data }),
    },
  };
}

function parseDeployFailure(stdout: string):
  | {
      readonly code: string;
      readonly message: string;
      readonly next?: string;
      readonly recoveryCommands?: readonly string[];
      readonly resume?: string;
    }
  | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as {
        ok?: unknown;
        error?: {
          code?: unknown;
          message?: unknown;
          next?: unknown;
          detail?: { actions?: unknown; resume?: unknown };
        };
      };
      const error = parsed.ok === false ? parsed.error : undefined;
      if (typeof error?.code !== 'string' || typeof error.message !== 'string') continue;
      const recoveryCommands = Array.isArray(error.detail?.actions)
        ? error.detail.actions
            .filter((command): command is string => isSafePublicRecoveryCommand(command))
            .slice(0, 32)
        : undefined;
      const resume = isSafePublicRecoveryCommand(error.detail?.resume)
        ? error.detail?.resume
        : undefined;
      return {
        code: error.code,
        message: error.message,
        ...(isSafePublicRecoveryCommand(error.next) ? { next: error.next } : {}),
        ...(recoveryCommands !== undefined && recoveryCommands.length > 0
          ? { recoveryCommands }
          : {}),
        ...(resume !== undefined ? { resume } : {}),
      };
    } catch {}
  }
  return undefined;
}

function isSafePublicRecoveryCommand(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1_000 &&
    value.startsWith('noodle ') &&
    !value.includes('--value') &&
    !value.includes('--auth-token')
  );
}
