import { gzipSync } from 'node:zlib';
import {
  MAX_COMPILED_WIDGET_HTML_BYTES,
  RECOMMENDED_COMPILED_WIDGET_HTML_BYTES,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import type { AuditFinding } from './mcp-apps-audit.js';
import { formatBytes } from './mcp-apps-audit.js';

type WidgetResource = NonNullable<RuntimeArtifact['resources']>[number];
type ArtifactTool = RuntimeArtifact['tools'][number];

export function auditWidgetQualityFindings(
  artifact: RuntimeArtifact,
  widgetResources: readonly WidgetResource[],
  linkedTools: readonly ArtifactTool[],
): readonly AuditFinding[] {
  return [
    auditReactWidgetMetadata(widgetResources),
    auditToolInputSufficiency(linkedTools),
    auditPayloadBudget(widgetResources),
    auditWidgetPrivacyBoundary(artifact, linkedTools),
  ];
}

function auditReactWidgetMetadata(widgetResources: readonly WidgetResource[]): AuditFinding {
  const missingTitles = widgetResources.filter((resource) => !resource.title);
  const missingDescriptions = widgetResources.filter((resource) => !resource.description);
  return {
    code: 'react_widget_metadata',
    severity: missingTitles.length === 0 && missingDescriptions.length === 0 ? 'info' : 'warn',
    message:
      missingTitles.length === 0 && missingDescriptions.length === 0
        ? 'React widget resources include title and description metadata for host review.'
        : `React widget metadata gaps: ${[
            ...(missingTitles.length > 0
              ? [`missing titles: ${missingTitles.map((resource) => resource.name).join(', ')}`]
              : []),
            ...(missingDescriptions.length > 0
              ? [
                  `missing descriptions: ${missingDescriptions.map((resource) => resource.name).join(', ')}`,
                ]
              : []),
          ].join('; ')}.`,
    cause:
      'Bring-your-own React widgets are opaque to the compiler, so host and marketplace review depend on explicit resource metadata.',
    fix: 'Add widget title and description fields next to the React view declaration.',
    next: 'noodle validate && noodle check',
  };
}

function auditToolInputSufficiency(linkedTools: readonly ArtifactTool[]): AuditFinding {
  const weak = linkedTools.filter((tool) => {
    if ((tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true)
      return false;
    const schema = asRecord(tool.inputSchema);
    if (schema?.type !== 'object') return true;
    return Object.keys(asRecord(schema.properties) ?? {}).length === 0;
  });
  return {
    code: 'tool_input_sufficiency',
    severity: weak.length === 0 ? 'info' : 'warn',
    message:
      weak.length === 0
        ? 'Widget-linked tools declare explicit object inputs for reliable model and widget calls.'
        : `Widget-linked tools need explicit object input fields: ${weak.map((tool) => tool.name).join(', ')}.`,
    cause:
      'Hidden memory, ambient state, and underspecified inputs make React widgets brittle across hosts and follow-up turns.',
    fix: 'Declare every required identifier, filter, quantity, or user choice in the tool input schema.',
    next: 'noodle validate && noodle check',
  };
}

function auditPayloadBudget(widgetResources: readonly WidgetResource[]): AuditFinding {
  const issues: string[] = [];
  for (const resource of widgetResources) {
    const html = literalHtml(resource);
    if (html === undefined) continue;
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > RECOMMENDED_COMPILED_WIDGET_HTML_BYTES) {
      const gzipBytes = gzipSync(Buffer.from(html, 'utf8')).byteLength;
      issues.push(
        `${resource.name} is ${formatBytes(bytes)} raw / ${formatBytes(gzipBytes)} gzip ` +
          `(recommended ${formatBytes(RECOMMENDED_COMPILED_WIDGET_HTML_BYTES)}; ` +
          `hard limit ${formatBytes(MAX_COMPILED_WIDGET_HTML_BYTES)})`,
      );
    }
    if (/<script\b/gi.test(html) && !html.includes('data-noodle-policy'))
      issues.push(`${resource.name} embeds inline script outside the Noodle runtime config`);
  }
  return {
    code: 'payload_budget',
    severity: issues.length === 0 ? 'info' : 'warn',
    message:
      issues.length === 0
        ? 'Widget HTML shells stay within portable payload budgets.'
        : `Payload budget gaps: ${issues.join('; ')}.`,
    cause:
      'Smaller initial widget resources load faster across MCP hosts; the recommendation is a performance signal, not a host compatibility limit.',
    fix: 'Keep initial widget code focused and load large media or dynamic data through declared resources and app-only tools.',
    next: 'noodle check && pnpm smoke:widgets',
  };
}

function auditWidgetPrivacyBoundary(
  artifact: RuntimeArtifact,
  linkedTools: readonly ArtifactTool[],
): AuditFinding {
  const schemaIssues = linkedTools.flatMap((tool) =>
    sensitiveSchemaPaths(tool.outputSchema).map((path) => `${tool.name}.${path}`),
  );
  const appOnlyTools = artifact.tools.filter((tool) => {
    const visibility = tool._meta?.ui?.visibility;
    return Array.isArray(visibility) && visibility.includes('app') && !visibility.includes('model');
  });
  return {
    code: 'widget_privacy_boundary',
    severity: schemaIssues.length > 0 ? 'error' : 'info',
    message:
      schemaIssues.length === 0
        ? `Widget-linked outputs avoid credential-shaped public fields; ${appOnlyTools.length} app-only helper tool(s) remain presentation-scoped through metadata, not authorization.`
        : `Widget privacy boundary gaps: ${schemaIssues.join('; ')}.`,
    cause:
      'Widget-linked tool output is rendered in host-controlled UI surfaces. Credential-shaped fields must stay in server-side credentials or reserved metadata, not public schemas.',
    fix: 'Remove secrets from widget-linked output schemas and keep credential material in the credential broker or reserved runtime metadata.',
    next: 'noodle validate && noodle check',
  };
}

function literalHtml(resource: WidgetResource): string | undefined {
  const fulfilment = resource.fulfilment;
  if (fulfilment.kind !== 'flow') return undefined;
  const value = fulfilment.output.value;
  return value?.kind === 'literal' && typeof value.value === 'string' ? value.value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sensitiveSchemaPaths(schema: unknown, prefix = ''): string[] {
  const record = asRecord(schema);
  if (!record) return [];
  const properties = asRecord(record.properties);
  const direct = Object.keys(properties ?? {}).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const child = properties?.[key];
    return [...(isSensitiveKey(key) ? [path] : []), ...sensitiveSchemaPaths(child, path)];
  });
  const items = record.items ? sensitiveSchemaPaths(record.items, `${prefix}[]`) : [];
  return [...direct, ...items];
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|api[_-]?key|credential|authorization|cookie|session)/i.test(key);
}
