import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { ConnectorInvocationError, isConnectorInvocationError } from '@noodle-borg/runtime';

export function normalizeMcpFailure(
  error: unknown,
  options: { readonly timedOut: boolean; readonly retryAfterMs?: number },
): ConnectorInvocationError {
  if (isConnectorInvocationError(error)) return error;
  if (
    options.timedOut ||
    (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout)
  ) {
    return new ConnectorInvocationError('upstream MCP request timed out', {
      category: 'timeout',
      retryable: false,
    });
  }
  if (SdkHttpError.isInstance(error)) {
    return new ConnectorInvocationError('upstream MCP transport rejected the request', {
      status: error.status,
      category: categoryForStatus(error.status),
      retryable: false,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    });
  }
  if (
    SdkError.isInstance(error) &&
    (error.code === SdkErrorCode.UnsupportedResultType ||
      error.code === SdkErrorCode.InvalidResult ||
      error.code === SdkErrorCode.EraNegotiationFailed)
  ) {
    return new ConnectorInvocationError('upstream MCP server returned an unsupported response', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  if (ProtocolError.isInstance(error)) {
    return new ConnectorInvocationError('upstream MCP protocol request failed', {
      category: error.code === -32601 ? 'upstream_4xx' : 'invalid_response',
      retryable: false,
    });
  }
  return new ConnectorInvocationError('upstream MCP network request failed', {
    category: 'network_error',
    retryable: false,
  });
}

function categoryForStatus(status: number): 'rate_limited' | 'upstream_5xx' | 'upstream_4xx' {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_5xx';
  return 'upstream_4xx';
}
