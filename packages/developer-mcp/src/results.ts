import type {
  DeveloperErrorCode,
  DeveloperFailure,
  DeveloperMcpContext,
  DeveloperNextAction,
  DeveloperResult,
  DeveloperSuccess,
} from './contracts.js';
import { DEVELOPER_MCP_CAPABILITY_VERSION } from './contracts.js';
import { DeveloperControlPlaneError } from './port.js';

export interface DeveloperToolResult<T> {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: DeveloperResult<T>;
  readonly isError?: true;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface ResultContext {
  readonly ctx: DeveloperMcpContext;
  readonly observedAt: () => string;
}

export function successResult<T>(
  options: ResultContext & {
    readonly data: T;
    readonly summary: string;
    readonly org?: string;
    readonly env?: string;
    readonly nextActions?: readonly DeveloperNextAction[];
  },
): DeveloperToolResult<T> {
  const structuredContent: DeveloperSuccess<T> = {
    ok: true,
    data: options.data,
    meta: resultMeta(options),
  };
  return {
    content: [{ type: 'text', text: options.summary }],
    structuredContent,
  };
}

export function errorResult<T = never>(
  options: ResultContext & {
    readonly code: DeveloperErrorCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly org?: string;
    readonly env?: string;
    readonly nextActions?: readonly DeveloperNextAction[];
  },
): DeveloperToolResult<T> {
  const structuredContent: DeveloperFailure = {
    ok: false,
    error: {
      code: options.code,
      message: options.message,
      retryable: options.retryable ?? false,
    },
    meta: resultMeta(options),
  };
  return {
    content: [{ type: 'text', text: options.message }],
    structuredContent,
    isError: true,
  };
}

export function validationError<T>(context: ResultContext, message: string) {
  return errorResult<T>({
    ...context,
    code: 'validation_failed',
    message,
  });
}

export function portError<T>(context: ResultContext, error: unknown, org?: string, env?: string) {
  if (error instanceof DeveloperControlPlaneError) {
    return errorResult<T>({
      ...context,
      code: error.code,
      message: error.message,
      retryable: error.code === 'dependency_unavailable' || error.code === 'rate_limited',
      ...(org !== undefined ? { org } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  }
  return errorResult<T>({
    ...context,
    code: 'internal_error',
    message: 'Noodle Cloud could not complete this operation.',
    retryable: true,
    ...(org !== undefined ? { org } : {}),
    ...(env !== undefined ? { env } : {}),
  });
}

function resultMeta(
  options: ResultContext & {
    readonly org?: string;
    readonly env?: string;
    readonly nextActions?: readonly DeveloperNextAction[];
  },
) {
  return {
    capabilityVersion: DEVELOPER_MCP_CAPABILITY_VERSION,
    ...(options.org !== undefined ? { org: options.org } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    observedAt: options.observedAt(),
    nextActions: [...(options.nextActions ?? [])],
  };
}
