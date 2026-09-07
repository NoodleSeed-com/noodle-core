import { injectWidgetBridge } from '@noodle-borg/protocol';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnalyticsWidget } from './analytics.js';
import { AppOverviewWidget } from './app-overview.js';
import { DeploymentDetailWidget } from './deployment-detail.js';
import { OperationsWidget } from './operations.js';
import { DEVELOPER_WIDGET_STYLES } from './styles.js';

export { AnalyticsWidget } from './analytics.js';
export { AppOverviewWidget } from './app-overview.js';
export { DeploymentDetailWidget } from './deployment-detail.js';
export { OperationsWidget } from './operations.js';

export const APP_OVERVIEW_WIDGET_URI = 'ui://noodle-developer/app-overview/v1' as const;
export const DEPLOYMENT_DETAIL_WIDGET_URI = 'ui://noodle-developer/deployment-detail/v1' as const;
export const OPERATIONS_WIDGET_URI = 'ui://noodle-developer/operations/v1' as const;
export const ANALYTICS_WIDGET_URI = 'ui://noodle-developer/analytics/v1' as const;
export const DEVELOPER_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app' as const;

interface DeveloperWidgetDefinition {
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: typeof DEVELOPER_WIDGET_MIME_TYPE;
  readonly component: ComponentType;
  readonly _meta: {
    readonly ui: {
      readonly csp: {
        readonly connectDomains: readonly string[];
        readonly resourceDomains: readonly string[];
      };
      readonly prefersBorder: true;
    };
    readonly 'openai/widgetDescription': string;
  };
}

const CLOSED_WIDGET_META = (description: string) => ({
  ui: {
    csp: { connectDomains: [], resourceDomains: [] },
    prefersBorder: true as const,
  },
  'openai/widgetDescription': description,
});

export const DEVELOPER_WIDGETS: readonly DeveloperWidgetDefinition[] = [
  {
    uri: APP_OVERVIEW_WIDGET_URI,
    name: 'noodle-developer-app-overview',
    title: 'Noodle app overview',
    description: 'Shows the selected Noodle Cloud app and deployment state.',
    mimeType: DEVELOPER_WIDGET_MIME_TYPE,
    component: AppOverviewWidget,
    _meta: CLOSED_WIDGET_META('A concise Noodle Cloud app and deployment overview.'),
  },
  {
    uri: DEPLOYMENT_DETAIL_WIDGET_URI,
    name: 'noodle-developer-deployment-detail',
    title: 'Noodle deployment detail',
    description: 'Shows deployment health, compatibility, and governed rollback state.',
    mimeType: DEVELOPER_WIDGET_MIME_TYPE,
    component: DeploymentDetailWidget,
    _meta: CLOSED_WIDGET_META('Noodle Cloud deployment health and governed rollback state.'),
  },
  {
    uri: OPERATIONS_WIDGET_URI,
    name: 'noodle-developer-operations',
    title: 'Noodle operations',
    description: 'Shows bounded diagnostic findings and recent logs.',
    mimeType: DEVELOPER_WIDGET_MIME_TYPE,
    component: OperationsWidget,
    _meta: CLOSED_WIDGET_META('Bounded Noodle Cloud diagnostic findings and recent logs.'),
  },
  {
    uri: ANALYTICS_WIDGET_URI,
    name: 'noodle-developer-analytics',
    title: 'Noodle analytics',
    description: 'Shows bounded request, error, latency, and tool metrics.',
    mimeType: DEVELOPER_WIDGET_MIME_TYPE,
    component: AnalyticsWidget,
    _meta: CLOSED_WIDGET_META('A bounded Noodle Cloud request analytics window.'),
  },
];

export interface RenderedDeveloperWidget {
  readonly uri: string;
  readonly mimeType: typeof DEVELOPER_WIDGET_MIME_TYPE;
  readonly text: string;
  readonly _meta: DeveloperWidgetDefinition['_meta'];
}

export function renderDeveloperWidget(uri: string): RenderedDeveloperWidget | undefined {
  const widget = DEVELOPER_WIDGETS.find((candidate) => candidate.uri === uri);
  if (widget === undefined) return undefined;
  const body = renderToStaticMarkup(createElement(widget.component));
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${widget.title}</title><style>${DEVELOPER_WIDGET_STYLES}</style></head><body>${body}</body></html>`;
  return {
    uri: widget.uri,
    mimeType: widget.mimeType,
    text: injectWidgetBridge(widget.mimeType, document),
    _meta: widget._meta,
  };
}
