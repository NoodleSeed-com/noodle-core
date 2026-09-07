import type { RequestOutcome } from './request-analytics.js';

export const INTENT_CATEGORIES = [
  'discover',
  'evaluate',
  'transact',
  'operate',
  'support',
  'other',
] as const;
export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

export const INTENT_MATCHES = ['direct', 'partial', 'workaround', 'unknown'] as const;
export type IntentMatch = (typeof INTENT_MATCHES)[number];

/** Validated model-supplied context. It never enters customer tool arguments or app logs. */
export interface IntentCaptureValue {
  readonly category: IntentCategory;
  readonly match: IntentMatch;
  readonly goal: string;
}

export const INTENT_CAPTURE_SCHEMA_VERSION = 1;
export type IntentCaptureMode = 'off' | 'starter-v1';

export interface IntentEventInput extends IntentCaptureValue {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly deploymentId?: string;
  readonly serverVersion?: string;
  readonly sdkProtocolVersion?: string;
  readonly protocolEra: 'legacy' | 'modern';
  readonly requestId: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolName: string;
  readonly outcome: RequestOutcome;
  readonly errorKind?: string;
  readonly source: 'tool_schema';
}

export interface IntentEvent extends IntentEventInput {
  readonly seq?: number;
  readonly id: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
}

export interface IntentEventFilter {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly toolName?: string;
  readonly category?: IntentCategory;
  readonly match?: IntentMatch;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface IntentEventSink {
  emit(event: IntentEventInput): Promise<void>;
}

export interface IntentEventStore extends IntentEventSink {
  list(filter: IntentEventFilter): Promise<readonly IntentEvent[]>;
  purge(filter: Pick<IntentEventFilter, 'org' | 'app' | 'env'>): Promise<number>;
}
