import type { IncomingMessage } from 'node:http';
import type { ProtocolRequestContext } from '@noodle-borg/protocol';
import { header } from './request-capture.js';

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
type WidgetDomainProjection = NonNullable<ProtocolRequestContext['widgetDomain']>;

export function widgetDomainProjectionForRequest(
  req: IncomingMessage,
  parsedBody: unknown,
  canonicalMcpUrl: string | undefined,
): WidgetDomainProjection | undefined {
  const body = record(Array.isArray(parsedBody) ? parsedBody[0] : parsedBody);
  const params = record(body?.params);
  const meta = record(params?._meta);
  const modernClientInfo = record(meta?.[CLIENT_INFO_META_KEY]);
  const legacyClientInfo = body?.method === 'initialize' ? record(params?.clientInfo) : undefined;
  const clientName =
    stringValue(modernClientInfo?.name) ??
    stringValue(legacyClientInfo?.name) ??
    header(req, 'user-agent');
  if (clientName === undefined || !isClaudeClient(clientName)) return undefined;
  return {
    host: 'claude',
    ...(canonicalMcpUrl === undefined ? {} : { mcpServerUrl: canonicalMcpUrl }),
  };
}

function isClaudeClient(value: string): boolean {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.includes('claude') || tokens.includes('anthropic');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
