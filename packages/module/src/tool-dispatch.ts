import type { OwnerCallerIdentity } from './contract.js';

export interface HostedToolDispatchContext {
  readonly org: string;
  readonly app: string;
  readonly environment: string;
  readonly deploymentId: string;
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly requestId: string | number;
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly invocationId?: string;
  readonly invocationRound?: number;
  readonly requestMeta?: unknown;
  readonly caller?: OwnerCallerIdentity;
  readonly client: {
    readonly protocolVersion?: string;
    readonly sessionId?: string;
    readonly userAgent?: string;
  };
}

export type ToolDispatchDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly kind?: undefined }
  | {
      readonly allow: false;
      readonly reason: 'billing_usage_limit_exceeded';
      readonly kind: 'usage_limit_exceeded';
      readonly resetAt: string;
    }
  | {
      readonly allow: false;
      readonly reason: 'billing_usage_duplicate_suppressed';
      readonly kind: 'duplicate_execution_suppressed';
    };

export type HostedToolDispatchHook = (
  context: HostedToolDispatchContext,
) => ToolDispatchDecision | Promise<ToolDispatchDecision>;

export interface NamedToolDispatchHook {
  readonly id: string;
  readonly order?: number;
  dispatch(context: HostedToolDispatchContext): Promise<ToolDispatchDecision>;
}
