import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { SERVED_MCP_PROTOCOL_VERSIONS } from '@noodle-borg/protocol';
import type { ZodType } from 'zod';

import {
  appInspectionViewSchema,
  DEVELOPER_MCP_CAPABILITY_VERSION,
  type DeveloperMcpContext,
  deploymentInspectionViewSchema,
  developerContextViewSchema,
  developerResultSchema,
  diagnoseAppInputSchema,
  eventsViewSchema,
  getContextInputSchema,
  getLogsInputSchema,
  getMetricsInputSchema,
  getSessionInputSchema,
  inspectAppInputSchema,
  inspectDeploymentInputSchema,
  listAppsInputSchema,
  listAppsViewSchema,
  listEventsInputSchema,
  logsViewSchema,
  metricsViewSchema,
  rollbackDeploymentInputSchema,
  rollbackViewSchema,
  sessionViewSchema,
} from './contracts.js';
import { diagnosisViewSchema } from './diagnosis.js';
import type { DeveloperControlPlane } from './port.js';
import { registerDeveloperPrompts } from './prompts.js';
import { registerDeveloperResources } from './resources.js';
import {
  diagnoseApp,
  getContext,
  getLogs,
  getMetrics,
  getSession,
  inspectApp,
  inspectDeployment,
  listApps,
  listEvents,
  rollbackDeployment,
} from './tools/index.js';
import { developerToolWidgetMeta } from './widget-links.js';

export interface CreateDeveloperMcpServerOptions {
  readonly context: DeveloperMcpContext;
  readonly controlPlane: DeveloperControlPlane;
  readonly observedAt?: () => string;
  /** Disable only the Apps projection; every headless tool and guidance resource remains available. */
  readonly enableWidgets?: boolean;
  /** Observe the semantic outcome without exposing tool inputs or result payloads. */
  readonly onToolResult?: (outcome: DeveloperToolOutcome) => void;
}

export interface DeveloperToolOutcome {
  readonly toolName: string;
  readonly decision: 'allow' | 'deny';
  readonly errorCode?: string;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ROLLBACK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createDeveloperMcpServer(options: CreateDeveloperMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'noodle-developer', version: DEVELOPER_MCP_CAPABILITY_VERSION },
    {
      supportedProtocolVersions: [...SERVED_MCP_PROTOCOL_VERSIONS],
      instructions:
        "Guide the user's existing coding agent. Use read-only Cloud evidence; never request source or secret values.",
    },
  );
  const context = {
    ctx: options.context,
    controlPlane: options.controlPlane,
    observedAt: options.observedAt ?? (() => new Date().toISOString()),
  };
  const widgetsEnabled = options.enableWidgets !== false;

  server.registerTool(
    'get_context',
    toolConfig(
      'Get selected Noodle Cloud context',
      'Return the signed-in user’s current organizations, roles, and effective capabilities.',
      getContextInputSchema,
      developerContextViewSchema,
    ),
    async () => asCallToolResult(await getContext(context), 'get_context', options.onToolResult),
  );
  server.registerTool(
    'list_apps',
    toolConfig(
      'List Noodle Cloud apps',
      'List apps in one explicit organization the signed-in user can currently access.',
      listAppsInputSchema,
      listAppsViewSchema,
    ),
    async (input) =>
      asCallToolResult(await listApps(context, input), 'list_apps', options.onToolResult),
  );
  server.registerTool(
    'inspect_app',
    toolConfig(
      'Inspect a Noodle Cloud app',
      'Inspect one app, optionally narrowed to a selected environment.',
      inspectAppInputSchema,
      appInspectionViewSchema,
      READ_ONLY_ANNOTATIONS,
      developerToolWidgetMeta('inspect_app', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(await inspectApp(context, input), 'inspect_app', options.onToolResult),
  );
  server.registerTool(
    'inspect_deployment',
    toolConfig(
      'Inspect a Noodle Cloud deployment',
      'Inspect one deployment ID within an explicit organization.',
      inspectDeploymentInputSchema,
      deploymentInspectionViewSchema,
      READ_ONLY_ANNOTATIONS,
      developerToolWidgetMeta('inspect_deployment', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(
        await inspectDeployment(context, input),
        'inspect_deployment',
        options.onToolResult,
      ),
  );
  server.registerTool(
    'get_logs',
    toolConfig(
      'Get bounded application logs',
      'Read redacted, bounded application log events for one selected app environment.',
      getLogsInputSchema,
      logsViewSchema,
      READ_ONLY_ANNOTATIONS,
      developerToolWidgetMeta('get_logs', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(await getLogs(context, input), 'get_logs', options.onToolResult),
  );
  server.registerTool(
    'get_metrics',
    toolConfig(
      'Get bounded MCP request metrics',
      'Aggregate a bounded request-event window for one selected app environment.',
      getMetricsInputSchema,
      metricsViewSchema,
      READ_ONLY_ANNOTATIONS,
      developerToolWidgetMeta('get_metrics', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(await getMetrics(context, input), 'get_metrics', options.onToolResult),
  );
  server.registerTool(
    'list_events',
    toolConfig(
      'List bounded MCP request events',
      'List redacted request events for one selected app environment.',
      listEventsInputSchema,
      eventsViewSchema,
    ),
    async (input) =>
      asCallToolResult(await listEvents(context, input), 'list_events', options.onToolResult),
  );
  server.registerTool(
    'get_session',
    toolConfig(
      'Get one MCP session chronology',
      'Read a bounded chronological request-event sequence for one session.',
      getSessionInputSchema,
      sessionViewSchema,
    ),
    async (input) =>
      asCallToolResult(await getSession(context, input), 'get_session', options.onToolResult),
  );
  server.registerTool(
    'diagnose_app',
    toolConfig(
      'Diagnose a Noodle app from Cloud evidence',
      'Apply deterministic rules to the minimum bounded evidence for one app environment.',
      diagnoseAppInputSchema,
      diagnosisViewSchema,
      READ_ONLY_ANNOTATIONS,
      developerToolWidgetMeta('diagnose_app', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(await diagnoseApp(context, input), 'diagnose_app', options.onToolResult),
  );
  server.registerTool(
    'rollback_deployment',
    toolConfig(
      'Roll back a Noodle Cloud deployment',
      'Use this when the user wants to reactivate one eligible deployment in the selected app environment.',
      rollbackDeploymentInputSchema,
      rollbackViewSchema,
      ROLLBACK_ANNOTATIONS,
      developerToolWidgetMeta('rollback_deployment', widgetsEnabled),
    ),
    async (input) =>
      asCallToolResult(
        await rollbackDeployment(context, input),
        'rollback_deployment',
        options.onToolResult,
      ),
  );

  registerDeveloperResources(server, { widgets: widgetsEnabled });
  registerDeveloperPrompts(server);
  return server;
}

function toolConfig<Input extends ZodType, Output extends ZodType>(
  title: string,
  description: string,
  inputSchema: Input,
  outputSchema: Output,
  annotations: typeof READ_ONLY_ANNOTATIONS | typeof ROLLBACK_ANNOTATIONS = READ_ONLY_ANNOTATIONS,
  _meta?: ReturnType<typeof developerToolWidgetMeta>,
) {
  return {
    title,
    description,
    inputSchema,
    outputSchema: developerResultSchema(outputSchema),
    annotations,
    ...(_meta === undefined ? {} : { _meta }),
  };
}

function asCallToolResult(
  result: unknown,
  toolName: string,
  observe?: (outcome: DeveloperToolOutcome) => void,
): CallToolResult {
  const structuredContent =
    typeof result === 'object' && result !== null && 'structuredContent' in result
      ? result.structuredContent
      : undefined;
  const failure =
    typeof structuredContent === 'object' &&
    structuredContent !== null &&
    'ok' in structuredContent &&
    structuredContent.ok === false
      ? structuredContent
      : undefined;
  const errorCode =
    failure !== undefined &&
    'error' in failure &&
    typeof failure.error === 'object' &&
    failure.error !== null &&
    'code' in failure.error &&
    typeof failure.error.code === 'string'
      ? failure.error.code
      : undefined;
  observe?.({
    toolName,
    decision: failure === undefined ? 'allow' : 'deny',
    ...(errorCode === undefined ? {} : { errorCode }),
  });
  return result as CallToolResult;
}
