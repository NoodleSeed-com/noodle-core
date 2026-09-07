import { createHash } from 'node:crypto';

type WidgetHostKind = 'claude' | 'generic';

export interface WidgetDomainProjection {
  readonly host: WidgetHostKind;
  readonly mcpServerUrl?: string;
}

export function claudeWidgetDomain(mcpServerUrl: string): string | undefined {
  try {
    const url = new URL(mcpServerUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const canonical = `${url.origin}${url.pathname}`;
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return `${hash}.claudemcpcontent.com`;
  } catch {
    return undefined;
  }
}

export function projectWidgetResourceMeta(
  meta: Readonly<Record<string, unknown>>,
  projection?: WidgetDomainProjection,
): Readonly<Record<string, unknown>> {
  const ui = record(meta.ui);
  if (ui === undefined || typeof ui.domain !== 'string') return meta;
  const configuredDomain = ui.domain;
  const projectedDomain =
    projection?.host === 'claude'
      ? projection.mcpServerUrl === undefined
        ? undefined
        : claudeWidgetDomain(projection.mcpServerUrl)
      : configuredDomain;
  const projectedUi = { ...ui };
  if (projectedDomain === undefined) delete projectedUi.domain;
  else projectedUi.domain = projectedDomain;
  return {
    ...meta,
    ui: projectedUi,
    ...(Object.hasOwn(meta, 'openai/widgetDomain')
      ? {}
      : { 'openai/widgetDomain': configuredDomain }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
