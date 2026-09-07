import {
  type AppInspectionView,
  appInspectionViewSchema,
  type InspectAppInput,
  inspectAppInputSchema,
  type ListAppsView,
  listAppsInputSchema,
  listAppsViewSchema,
} from '../contracts.js';
import type { DeveloperControlPlane } from '../port.js';
import { portError, type ResultContext, successResult, validationError } from '../results.js';

interface AppsToolContext extends ResultContext {
  readonly controlPlane: DeveloperControlPlane;
}

export async function listApps(context: AppsToolContext, input: unknown) {
  const parsed = listAppsInputSchema.safeParse(input);
  if (!parsed.success) return validationError<ListAppsView>(context, 'Invalid list_apps input.');
  try {
    const data = listAppsViewSchema.parse(
      await context.controlPlane.listApps(context.ctx, parsed.data),
    );
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      summary: `${data.apps.length} app${data.apps.length === 1 ? '' : 's'} in ${parsed.data.org}.`,
      nextActions: [
        { kind: 'call_tool', label: 'Inspect an app', tool: 'inspect_app' },
        { kind: 'call_tool', label: 'Diagnose an app environment', tool: 'diagnose_app' },
      ],
    });
  } catch (error) {
    return portError<ListAppsView>(context, error, parsed.data.org);
  }
}

export async function inspectApp(context: AppsToolContext, input: unknown) {
  const parsed = inspectAppInputSchema.safeParse(input);
  if (!parsed.success)
    return validationError<AppInspectionView>(context, 'Invalid inspect_app input.');
  try {
    const data = appInspectionViewSchema.parse(
      await context.controlPlane.inspectApp(context.ctx, parsed.data),
    );
    const env = parsed.data.env ?? data.selectedEnvironment;
    return successResult({
      ...context,
      data,
      org: parsed.data.org,
      summary: `${data.app} has ${data.environments.length} visible environment${data.environments.length === 1 ? '' : 's'}.`,
      ...(env !== undefined ? { env } : {}),
      nextActions: appNextActions(parsed.data, data),
    });
  } catch (error) {
    return portError<AppInspectionView>(context, error, parsed.data.org, parsed.data.env);
  }
}

function appNextActions(input: InspectAppInput, data: AppInspectionView) {
  const actions = [];
  if (data.latest !== undefined) {
    actions.push({
      kind: 'call_tool' as const,
      label: 'Inspect the latest deployment',
      tool: 'inspect_deployment',
    });
  }
  if (input.env !== undefined) {
    actions.push(
      { kind: 'call_tool' as const, label: 'Read recent logs', tool: 'get_logs' },
      { kind: 'call_tool' as const, label: 'Diagnose this environment', tool: 'diagnose_app' },
    );
  }
  return actions;
}

export type { InspectAppInput };
