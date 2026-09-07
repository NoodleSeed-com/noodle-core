import type { CallToolResult } from '@modelcontextprotocol/client';
import { ConnectorInvocationError } from '@noodle-borg/runtime';

export function normalizeToolResult(result: CallToolResult, maxBytes: number): unknown {
  if (result.isError === true) {
    throw new ConnectorInvocationError('upstream MCP tool reported an execution error', {
      category: 'upstream_4xx',
      retryable: false,
    });
  }

  if (result.structuredContent !== undefined) {
    if (!isRecord(result.structuredContent)) {
      throw invalidResult('upstream MCP structured content must be an object');
    }
    assertEncodedSize(result.structuredContent, maxBytes);
    return result.structuredContent;
  }

  const text = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> =>
      isTextBlock(block),
    )
    .map((block) => block.text)
    .join('\n');
  if (text.length === 0) {
    throw invalidResult('upstream MCP tool returned no structured or text content');
  }
  assertEncodedSize(text, maxBytes);
  return { text };
}

function isTextBlock(value: unknown): value is { readonly type: 'text'; readonly text: string } {
  if (!isRecord(value)) return false;
  return value.type === 'text' && typeof value.text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertEncodedSize(value: unknown, maxBytes: number): void {
  let encoded: string;
  try {
    encoded = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    throw invalidResult('upstream MCP result was not serializable');
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new ConnectorInvocationError('upstream MCP result exceeds the size limit', {
      category: 'response_too_large',
      retryable: false,
    });
  }
}

function invalidResult(message: string): ConnectorInvocationError {
  return new ConnectorInvocationError(message, {
    category: 'invalid_response',
    retryable: false,
  });
}
