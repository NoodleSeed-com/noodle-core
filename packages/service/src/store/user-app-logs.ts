import { randomUUID } from 'node:crypto';
import { type AuditDetails, redactDetails } from '@noodle-borg/module';
import { validateSlug } from '../store.js';

export type UserAppLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface UserAppLogInput {
  readonly level: UserAppLogLevel;
  readonly message: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly deploymentId?: string;
  readonly toolName?: string;
  readonly executionId?: string;
  readonly toolCallId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly truncated?: boolean;
}

export interface UserAppLogEvent {
  readonly id: string;
  readonly createdAt: string;
  readonly level: UserAppLogLevel;
  readonly message: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly deploymentId?: string;
  readonly toolName?: string;
  readonly executionId?: string;
  readonly toolCallId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly details?: AuditDetails;
  readonly truncated?: boolean;
}

export interface UserAppLogFilter {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly deploymentId?: string;
  readonly toolName?: string;
  readonly executionId?: string;
  readonly level?: UserAppLogLevel;
  /** Case-insensitive substring over the message (plain text, never a regex — no ReDoS surface). */
  readonly contains?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface UserAppLogSink {
  emit(input: UserAppLogInput): Promise<void>;
}

export interface UserAppLogStore extends UserAppLogSink {
  list(filter: UserAppLogFilter): Promise<readonly UserAppLogEvent[]>;
}

export interface InMemoryUserAppLogStoreOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly maxMessageChars?: number;
}

const DEFAULT_MAX_MESSAGE_CHARS = 4096;

export class InMemoryUserAppLogStore implements UserAppLogStore {
  readonly #events: UserAppLogEvent[] = [];
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #maxMessageChars: number;

  constructor(options: InMemoryUserAppLogStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => randomUUID());
    this.#maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  }

  async emit(input: UserAppLogInput): Promise<void> {
    const org = requireSlug('org', input.org);
    const app = requireSlug('app', input.app);
    const env = requireSlug('env', input.env);
    const { message, truncated } = truncateMessage(
      String(input.message),
      this.#maxMessageChars,
      input.truncated === true,
    );
    const details = redactDetails(input.details);
    this.#events.push({
      id: this.#id(),
      createdAt: this.#now().toISOString(),
      level: input.level,
      message,
      org,
      app,
      env,
      ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  }

  list(filter: UserAppLogFilter): Promise<readonly UserAppLogEvent[]> {
    const org = validateSlug('org', filter.org);
    const needle = filter.contains?.toLowerCase();
    const matched = this.#events.filter(
      (event) =>
        event.org === org &&
        (filter.app === undefined || event.app === filter.app) &&
        (filter.env === undefined || event.env === filter.env) &&
        (filter.deploymentId === undefined || event.deploymentId === filter.deploymentId) &&
        (filter.toolName === undefined || event.toolName === filter.toolName) &&
        (filter.executionId === undefined || event.executionId === filter.executionId) &&
        (filter.level === undefined || event.level === filter.level) &&
        (needle === undefined || event.message.toLowerCase().includes(needle)) &&
        (filter.since === undefined || event.createdAt >= filter.since) &&
        (filter.until === undefined || event.createdAt <= filter.until),
    );
    matched.reverse();
    return Promise.resolve(filter.limit !== undefined ? matched.slice(0, filter.limit) : matched);
  }
}

function requireSlug(name: 'org' | 'app' | 'env', value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return validateSlug(name, value);
}

function truncateMessage(
  message: string,
  maxChars: number,
  alreadyTruncated: boolean,
): { readonly message: string; readonly truncated: boolean } {
  if (message.length <= maxChars) return { message, truncated: alreadyTruncated };
  return { message: message.slice(0, maxChars), truncated: true };
}
