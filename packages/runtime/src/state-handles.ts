import type { ArtifactState, ArtifactStateHandle, OperationSignature } from '@noodle-borg/compiler';
import type { Connector, ConnectorCall } from './connector/types.js';

export const STATE_CONNECTOR_ID = 'noodle_state';
export const STATE_CONNECTOR_VERSION = '1.0.0';
export const READ_STATE_OPERATION = 'read_state';
export const PATCH_STATE_OPERATION = 'patch_state';
export const COMPLETE_STATE_OPERATION = 'complete_state';

export const STATE_OPERATION_SIGNATURES: Readonly<Record<string, OperationSignature>> = {
  [READ_STATE_OPERATION]: {
    type: 'read',
    input: {
      type: 'object',
      properties: { handle: { type: 'string' }, key: { type: 'string' } },
      required: ['handle'],
      additionalProperties: false,
    },
    output: stateOutputSignature(),
  },
  [PATCH_STATE_OPERATION]: {
    type: 'action',
    input: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        key: { type: 'string' },
        expectedRevision: { type: 'integer' },
        value: { type: 'object' },
      },
      required: ['handle', 'expectedRevision', 'value'],
      additionalProperties: false,
    },
    output: stateOutputSignature(),
  },
  [COMPLETE_STATE_OPERATION]: {
    type: 'action',
    input: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        key: { type: 'string' },
        expectedRevision: { type: 'integer' },
      },
      required: ['handle', 'expectedRevision'],
      additionalProperties: false,
    },
    output: stateOutputSignature(),
  },
};

export interface StateHandleRecord {
  readonly handle: string;
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly revision: number;
  readonly status: 'active' | 'completed' | 'expired';
  readonly expiresAt?: string;
}

export interface MutableStateHandleRecord {
  handle: string;
  key: string;
  value: Record<string, unknown>;
  revision: number;
  status: 'active' | 'completed';
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface StateHandleStore {
  read(input: StateInput): Promise<StateHandleRecord> | StateHandleRecord;
  patch(input: StatePatchInput): Promise<StateHandleRecord> | StateHandleRecord;
  complete(input: StateMutationInput): Promise<StateHandleRecord> | StateHandleRecord;
}

export interface StateInput {
  readonly handle: string;
  readonly key?: string;
  readonly callerSubject?: string;
}

export interface StateMutationInput extends StateInput {
  readonly expectedRevision: number;
}

export interface StatePatchInput extends StateMutationInput {
  readonly value: Record<string, unknown>;
}

export class InMemoryStateHandleStore implements StateHandleStore {
  readonly #state: ArtifactState;
  readonly #records = new Map<string, MutableStateHandleRecord>();
  readonly #now: () => Date;

  constructor(state: ArtifactState, now: () => Date = () => new Date()) {
    this.#state = state;
    this.#now = now;
  }

  read(input: StateInput): StateHandleRecord {
    const def = this.#definition(input.handle);
    const key = this.#recordKey(def, input);
    const now = this.#now().getTime();
    return toPublicStateHandleRecord(
      this.#records.get(key) ??
        createMutableStateHandleRecord(input.handle, input.key ?? 'default', def.ttlSeconds, now),
      now,
    );
  }

  patch(input: StatePatchInput): StateHandleRecord {
    const def = this.#definition(input.handle);
    const key = this.#recordKey(def, input);
    const now = this.#now().getTime();
    const current = stateHandleRecordForMutation(
      this.#records.get(key),
      input.handle,
      input.key ?? 'default',
      def.ttlSeconds,
      now,
    );
    assertStateHandleNotCompleted(current);
    assertExpectedStateRevision(current, input.expectedRevision);
    assertNoSecretValue(input.value);
    const value = { ...current.value, ...input.value };
    assertSchemaValue(def.schema, value);
    const next: MutableStateHandleRecord = {
      ...current,
      value,
      revision: current.revision + 1,
      updatedAt: now,
    };
    this.#records.set(key, next);
    return toPublicStateHandleRecord(next, now);
  }

  complete(input: StateMutationInput): StateHandleRecord {
    const def = this.#definition(input.handle);
    const key = this.#recordKey(def, input);
    const now = this.#now().getTime();
    const current = stateHandleRecordForMutation(
      this.#records.get(key),
      input.handle,
      input.key ?? 'default',
      def.ttlSeconds,
      now,
    );
    assertStateHandleNotCompleted(current);
    assertExpectedStateRevision(current, input.expectedRevision);
    const next: MutableStateHandleRecord = {
      ...current,
      status: 'completed',
      revision: current.revision + 1,
      updatedAt: now,
    };
    this.#records.set(key, next);
    return toPublicStateHandleRecord(next, now);
  }

  #definition(handle: string): ArtifactStateHandle {
    const def = this.#state.handles[handle];
    if (def === undefined) throw new Error(`unknown state handle "${handle}"`);
    return def;
  }

  #recordKey(def: ArtifactStateHandle, input: StateInput): string {
    const userKey = input.key ?? 'default';
    const owner = def.scope === 'caller' ? (input.callerSubject ?? 'anonymous') : 'deployment';
    return `${input.handle}\u0000${owner}\u0000${userKey}`;
  }
}

export class StateConnector implements Connector {
  readonly id = STATE_CONNECTOR_ID;
  readonly version = STATE_CONNECTOR_VERSION;
  readonly #store: StateHandleStore;

  constructor(store: StateHandleStore) {
    this.#store = store;
  }

  signature(operation: string): OperationSignature | undefined {
    return STATE_OPERATION_SIGNATURES[operation];
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    switch (call.operation) {
      case READ_STATE_OPERATION:
        return ok(await this.#store.read(stateInput(call)));
      case PATCH_STATE_OPERATION:
        return ok(
          await this.#store.patch({
            ...stateInput(call),
            expectedRevision: integerArg(call.args.expectedRevision, 'expectedRevision'),
            value: objectArg(call.args.value, 'value'),
          }),
        );
      case COMPLETE_STATE_OPERATION:
        return ok(
          await this.#store.complete({
            ...stateInput(call),
            expectedRevision: integerArg(call.args.expectedRevision, 'expectedRevision'),
          }),
        );
      default:
        throw new Error(`state connector has no operation "${call.operation}"`);
    }
  }
}

export function createStateConnector(state: ArtifactState | undefined): StateConnector | undefined {
  return state === undefined ? undefined : new StateConnector(new InMemoryStateHandleStore(state));
}

function stateOutputSignature(): OperationSignature['output'] {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      handle: { type: 'string' },
      value: { type: 'object' },
      revision: { type: 'integer' },
      status: { type: 'string' },
      expiresAt: { type: 'string' },
    },
    required: ['ok', 'handle', 'value', 'revision', 'status'],
    additionalProperties: false,
  };
}

function stateInput(call: ConnectorCall): StateInput {
  return {
    handle: stringArg(call.args.handle, 'handle'),
    ...(call.args.key !== undefined ? { key: stringArg(call.args.key, 'key') } : {}),
    ...(call.caller?.subject !== undefined ? { callerSubject: call.caller.subject } : {}),
  };
}

function ok(record: StateHandleRecord): Record<string, unknown> {
  return {
    ok: true,
    handle: record.handle,
    value: record.value,
    revision: record.revision,
    status: record.status,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a string`);
  return value;
}

function integerArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function createMutableStateHandleRecord(
  handle: string,
  key: string,
  ttlSeconds: number | undefined,
  now: number,
): MutableStateHandleRecord {
  return {
    handle,
    key,
    value: {},
    revision: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(ttlSeconds !== undefined ? { expiresAt: now + ttlSeconds * 1000 } : {}),
  };
}

export function stateHandleRecordForMutation(
  record: MutableStateHandleRecord | undefined,
  handle: string,
  key: string,
  ttlSeconds: number | undefined,
  now: number,
): MutableStateHandleRecord {
  if (record === undefined) return createMutableStateHandleRecord(handle, key, ttlSeconds, now);
  if (!isExpired(record, now)) return record;
  return {
    ...createMutableStateHandleRecord(handle, key, ttlSeconds, now),
    revision: record.revision + 1,
  };
}

export function assertStateHandleNotCompleted(record: MutableStateHandleRecord): void {
  if (record.status === 'completed') throw new Error('completed state handles are read-only');
}

function isExpired(record: MutableStateHandleRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now;
}

export function assertExpectedStateRevision(
  record: MutableStateHandleRecord,
  expectedRevision: number,
): void {
  if (record.revision !== expectedRevision) {
    throw new Error(
      `state revision conflict: expected ${expectedRevision}, got ${record.revision}`,
    );
  }
}

export function toPublicStateHandleRecord(
  record: MutableStateHandleRecord,
  now: number,
): StateHandleRecord {
  const expired = isExpired(record, now);
  return {
    handle: record.handle,
    key: record.key,
    value: record.value,
    revision: record.revision + (expired ? 1 : 0),
    status: expired ? 'expired' : record.status,
    ...(record.expiresAt !== undefined
      ? { expiresAt: new Date(record.expiresAt).toISOString() }
      : {}),
  };
}

const SECRET_LIKE_FIELD = /(secret|token|api[_-]?key|password|credential|authorization|cookie)/i;

export function assertNoSecretValue(value: unknown, path = 'value'): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSecretValue(item, `${path}.${index}`);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_LIKE_FIELD.test(key)) {
      throw new Error(`state value field "${path}.${key}" looks credential-shaped`);
    }
    assertNoSecretValue(child, `${path}.${key}`);
  }
}

export function assertSchemaValue(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): void {
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error('state handle schema must describe an object value');
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required) {
    if (typeof field === 'string' && value[field] === undefined) {
      throw new Error(`state value missing required field "${field}"`);
    }
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (value[field] === undefined || !isPlainObject(fieldSchema)) continue;
    assertPrimitiveType(field, value[field], fieldSchema.type);
  }
}

function assertPrimitiveType(field: string, value: unknown, type: unknown): void {
  if (typeof type !== 'string') return;
  if (type === 'integer') {
    if (!Number.isInteger(value))
      throw new Error(`state value field "${field}" must be an integer`);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`state value field "${field}" must be an array`);
    return;
  }
  if (type === 'object') {
    if (!isPlainObject(value)) throw new Error(`state value field "${field}" must be an object`);
    return;
  }
  if (typeof value !== type) throw new Error(`state value field "${field}" must be a ${type}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
