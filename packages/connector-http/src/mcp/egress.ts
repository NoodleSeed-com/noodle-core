import type { FetchLike } from '@modelcontextprotocol/client';
import {
  type ConnectorCall,
  ConnectorInvocationError,
  type DownstreamCredential,
} from '@noodle-borg/runtime';
import { guardedFetch } from '../ssrf.js';
import type { McpAuthScheme, McpConnectorDependencies } from './types.js';

interface McpEgressOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly auth?: McpAuthScheme;
  readonly call: ConnectorCall;
  readonly maxResponseBytes: number;
  readonly dependencies: McpConnectorDependencies;
  readonly onResponseLimitExceeded: () => void;
  readonly onNetworkFailure: () => void;
  readonly onRetryAfter: (retryAfterMs: number) => void;
}

/** Build one invocation-scoped fetch so credential material can never outlive or cross a call. */
export function invocationFetch(options: McpEgressOptions): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (!options.allowedOrigins.has(url.origin)) {
      throw new ConnectorInvocationError(
        `upstream MCP request resolved to a disallowed origin "${url.origin}"`,
        { category: 'invalid_response', retryable: false },
      );
    }

    const headers = new Headers(init.headers);
    attachCredential(
      headers,
      options.call.credentialPresentation ?? options.auth,
      options.call.credential,
    );
    const request: RequestInit = { ...init, headers, redirect: 'manual' };
    let response: Response;
    try {
      response =
        options.dependencies.fetch === undefined
          ? await guardedFetch(url, request, {
              ...(options.dependencies.lookup === undefined
                ? {}
                : { lookup: options.dependencies.lookup }),
            })
          : await options.dependencies.fetch(url, request);
    } catch (error) {
      options.onNetworkFailure();
      throw error;
    }

    if (response.status >= 300 && response.status <= 399) {
      throw new ConnectorInvocationError('upstream MCP redirect rejected', {
        status: response.status,
        category: 'invalid_response',
        retryable: false,
      });
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      if (retryAfterMs !== undefined) options.onRetryAfter(retryAfterMs);
    }
    return boundedResponse(response, options.maxResponseBytes, options.onResponseLimitExceeded);
  };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, time - Date.now());
}

function attachCredential(
  headers: Headers,
  scheme: McpAuthScheme | undefined,
  credential: DownstreamCredential,
): void {
  if (scheme === undefined) return;
  if (scheme.kind === 'cookie') {
    if (credential.kind !== 'cookie') {
      throw new ConnectorInvocationError('MCP cookie auth requires a cookie credential', {
        category: 'invalid_response',
        retryable: false,
      });
    }
    headers.set('cookie', credential.cookie);
    return;
  }
  if (credential.kind === 'cookie') {
    throw new ConnectorInvocationError('MCP token auth requires a token credential', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  if (scheme.kind === 'bearer') headers.set('authorization', `Bearer ${credential.token}`);
  else headers.set(scheme.header, credential.token);
}

function boundedResponse(response: Response, maxBytes: number, onExceeded: () => void): Response {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) {
    onExceeded();
    throw responseTooLarge();
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          onExceeded();
          await reader.cancel().catch(() => undefined);
          controller.error(responseTooLarge());
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function responseTooLarge(): ConnectorInvocationError {
  return new ConnectorInvocationError('upstream MCP response exceeds the size limit', {
    category: 'response_too_large',
    retryable: false,
  });
}
