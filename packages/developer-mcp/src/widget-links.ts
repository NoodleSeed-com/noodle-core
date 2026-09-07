import {
  ANALYTICS_WIDGET_URI,
  APP_OVERVIEW_WIDGET_URI,
  DEPLOYMENT_DETAIL_WIDGET_URI,
  OPERATIONS_WIDGET_URI,
} from './widgets/resources.js';

export const TOOL_WIDGET_LINKS = {
  inspect_app: APP_OVERVIEW_WIDGET_URI,
  inspect_deployment: DEPLOYMENT_DETAIL_WIDGET_URI,
  get_logs: OPERATIONS_WIDGET_URI,
  diagnose_app: OPERATIONS_WIDGET_URI,
  get_metrics: ANALYTICS_WIDGET_URI,
  rollback_deployment: DEPLOYMENT_DETAIL_WIDGET_URI,
} as const;

export type WidgetLinkedTool = keyof typeof TOOL_WIDGET_LINKS;

export function developerToolWidgetMeta(tool: string, enabled: boolean) {
  if (!enabled || !(tool in TOOL_WIDGET_LINKS)) return undefined;
  const uri = TOOL_WIDGET_LINKS[tool as WidgetLinkedTool];
  return {
    ui: { resourceUri: uri },
    // ChatGPT compatibility projection; `ui.resourceUri` remains the host-neutral MCP Apps source.
    'openai/outputTemplate': uri,
  } as const;
}
