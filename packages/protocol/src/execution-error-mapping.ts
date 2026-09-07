import type { ExecutionError } from '@noodle-borg/runtime';
import { JSON_RPC } from './jsonrpc.js';
import type { CallToolOutcome } from './mapping.js';

/** Execution-error codes surfaced to the caller as `isError: true` tool results (model-actionable). */
const TOOL_EXECUTION_ERRORS = new Set([
  'arg_invalid',
  'expression_error',
  'connector_error',
  'output_invalid',
  'credential_unavailable',
  'connector_route_unavailable',
  'usage_limit_exceeded',
  'duplicate_execution_suppressed',
]);

/** Execution-error codes surfaced as JSON-RPC `-32602` (a malformed/unknown request). */
const INVALID_PARAMS_ERRORS = new Set(['unknown_tool']);

/**
 * The allowlisted `connector_error` reasons that reach the wire as structured diagnostics. These
 * are stable classifications (oversized response; execution or queue-wait time-budget expiry) —
 * anything else stays a bare `connector_error` so backend detail never leaks.
 */
const CONNECTOR_ERROR_STRUCTURED_REASONS = new Set([
  'response_too_large',
  'timeout',
  'queue_timeout',
]);

/**
 * Map an execution error to its MCP channel. Call-time, model-correctable failures become an
 * `isError: true` tool result; an unknown tool is an invalid-params protocol error; everything else
 * (server-side faults: shape-only artifact, connector unavailable, signature drift, unsupported
 * fulfilment, policy denial) is an internal protocol error. The split is intentional and auditable.
 */
export function mapExecutionError(error: ExecutionError): CallToolOutcome {
  if (error.code === 'connector_route_unavailable') {
    return {
      result: {
        content: [
          {
            type: 'text',
            text: 'Customer connector route is unavailable.',
          },
        ],
        structuredContent: {
          error: { code: 'connector_route_unavailable' },
        },
        isError: true,
      },
    };
  }
  if (TOOL_EXECUTION_ERRORS.has(error.code)) {
    const text = [
      error.message,
      ...(error.fix === undefined ? [] : [`Fix: ${error.fix}`]),
      ...(error.next === undefined || error.next.length === 0
        ? []
        : [`Next: ${error.next.join(', ')}`]),
    ].join('\n');
    const structuredError = {
      code: error.code,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.fix === undefined ? {} : { fix: error.fix }),
      ...(error.next === undefined ? {} : { next: error.next }),
    };
    return {
      result: {
        content: [{ type: 'text', text }],
        ...(error.code === 'credential_unavailable' ||
        (error.code === 'connector_error' &&
          error.reason !== undefined &&
          CONNECTOR_ERROR_STRUCTURED_REASONS.has(error.reason))
          ? { structuredContent: { error: structuredError } }
          : {}),
        isError: true,
      },
    };
  }
  if (INVALID_PARAMS_ERRORS.has(error.code)) {
    return { error: { code: JSON_RPC.INVALID_PARAMS, message: error.message } };
  }
  return { error: { code: JSON_RPC.INTERNAL_ERROR, message: error.message } };
}
