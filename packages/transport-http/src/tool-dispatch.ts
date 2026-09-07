import type { IncomingMessage } from 'node:http';
import type { HostedToolDispatchContext, HostedToolDispatchHook } from '@noodle-borg/module';
import type { ProtocolRequestContext } from '@noodle-borg/protocol';
import { header } from './request-capture.js';

export type { HostedToolDispatchContext, HostedToolDispatchHook } from '@noodle-borg/module';

interface HostedToolDispatchTarget {
  readonly beforeToolDispatch: HostedToolDispatchHook | undefined;
  readonly org: string | undefined;
  readonly app: string | undefined;
  readonly environment: string | undefined;
  readonly deploymentId: string | undefined;
}

/** Attach hosted facts only after auth for the runtime's once-per-tool-call usage admission. */
export function withHostedToolDispatch(
  req: IncomingMessage,
  parsed: unknown,
  context: ProtocolRequestContext,
  target: HostedToolDispatchTarget,
): ProtocolRequestContext {
  const hook = target.beforeToolDispatch;
  if (
    hook === undefined ||
    target.org === undefined ||
    target.app === undefined ||
    target.environment === undefined ||
    target.deploymentId === undefined
  ) {
    return context;
  }
  const dispatchBase = {
    org: target.org,
    app: target.app,
    environment: target.environment,
    deploymentId: target.deploymentId,
    ...(context.caller !== undefined ? { caller: context.caller } : {}),
    client: dispatchClientContext(req, parsed),
  };
  return {
    ...context,
    beforeToolDispatch: (dispatch) => hook({ ...dispatchBase, ...dispatch }),
  };
}

function dispatchClientContext(
  req: IncomingMessage,
  parsed: unknown,
): HostedToolDispatchContext['client'] {
  const modernVersion = modernProtocolVersion(parsed);
  const protocolVersion = modernVersion ?? header(req, 'mcp-protocol-version');
  const sessionId = modernVersion === undefined ? header(req, 'mcp-session-id') : undefined;
  const userAgent = header(req, 'user-agent');
  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

function modernProtocolVersion(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (!isRecord(first) || !isRecord(first.params) || !isRecord(first.params._meta)) {
    return undefined;
  }
  const version = first.params._meta['io.modelcontextprotocol/protocolVersion'];
  return typeof version === 'string' ? version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
