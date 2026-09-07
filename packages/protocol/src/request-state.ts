import { createHash, hkdfSync } from 'node:crypto';
import {
  type ElicitationResponse,
  type SealedSecret,
  SecretBox,
  staticMasterKeyProvider,
} from '@noodle-borg/runtime';

const REQUEST_STATE_KEY_LABEL = 'noodle-seed/mcp-request-state/v1';
const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_MAX_TOKEN_BYTES = 16_384;
const LEGACY_INTERACTION_ARGUMENT = '__noodleInteraction';

export type RequestStateMethod = 'tools/call' | 'resources/read' | 'prompts/get';

export interface RequestStateBinding {
  readonly executionRevision?: string;
  readonly deploymentId: string;
  readonly serverVersion: string;
  readonly method: RequestStateMethod;
  readonly target: string;
  readonly principal: string;
  readonly argumentDigest: string;
}

export interface SealedRequestState {
  readonly responses: Readonly<Record<string, ElicitationResponse>>;
  readonly round: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly binding: RequestStateBinding;
  readonly pendingRequest: {
    readonly id: string;
    readonly interaction: 'input' | 'confirmation';
  };
  readonly confirmation?: true;
}

export interface SealRequestStateInput extends SealedRequestState {}

export interface RequestStateManagerOptions {
  readonly now?: () => number;
  readonly maxRounds?: number;
  readonly maxTokenBytes?: number;
}

export interface ConfirmationNonceLedger {
  /** Atomically consume one nonce until its expiry. Returns false for a replay. */
  consume(nonce: string, expiresAt: number): Promise<boolean>;
}

export type RequestStateRejectionReason =
  | 'request_state_verification_failed'
  | 'request_state_expired'
  | 'request_state_binding_mismatch'
  | 'request_state_argument_mismatch'
  | 'missing_request_state'
  | 'unexpected_input_response_key'
  | 'invalid_input_response_shape'
  | 'dropped_input_response_envelope'
  | 'confirmation_replay'
  | 'confirmation_ledger_unavailable';

/** Opaque failure used for every malformed, expired, tampered, or mis-bound state. */
export class RequestStateError extends Error {
  constructor(readonly reason: RequestStateRejectionReason = 'request_state_verification_failed') {
    super('Invalid or expired requestState');
    this.name = 'RequestStateError';
  }
}

/** Derive a domain-separated static SecretBox from the existing 32-byte operator master key. */
export function requestStateSecretBox(masterKey: Buffer): SecretBox {
  if (masterKey.length !== 32) throw new Error('request-state master key must be exactly 32 bytes');
  const derived = Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.alloc(0), REQUEST_STATE_KEY_LABEL, 32),
  );
  return new SecretBox(
    staticMasterKeyProvider(derived.toString('base64'), 'mcp-request-state-hkdf-v1'),
  );
}

/** Seal and verify bounded, confidential MRTR state using the runtime's AES-256-GCM primitive. */
export class RequestStateManager {
  readonly #secretBox: SecretBox;
  readonly #now: () => number;
  readonly #maxRounds: number;
  readonly #maxTokenBytes: number;

  constructor(secretBox: SecretBox, options: RequestStateManagerOptions = {}) {
    this.#secretBox = secretBox;
    this.#now = options.now ?? Date.now;
    this.#maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.#maxTokenBytes = options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES;
    if (!Number.isSafeInteger(this.#maxRounds) || this.#maxRounds < 1) {
      throw new RangeError('maxRounds must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#maxTokenBytes) || this.#maxTokenBytes < 256) {
      throw new RangeError('maxTokenBytes must be a safe integer of at least 256');
    }
  }

  async seal(input: SealRequestStateInput): Promise<string> {
    try {
      assertPayload(input, this.#maxRounds);
      const plaintext = JSON.stringify({ v: 1, ...input });
      if (Buffer.byteLength(plaintext) > this.#maxTokenBytes) throw new RequestStateError();
      const sealed = await this.#secretBox.seal(plaintext);
      const token = Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url');
      if (Buffer.byteLength(token) > this.#maxTokenBytes) throw new RequestStateError();
      return token;
    } catch (error) {
      if (error instanceof RequestStateError) throw error;
      throw new RequestStateError();
    }
  }

  async open(token: string, expectedBinding?: RequestStateBinding): Promise<SealedRequestState> {
    try {
      if (
        token.length === 0 ||
        Buffer.byteLength(token) > this.#maxTokenBytes ||
        !/^[A-Za-z0-9_-]+$/.test(token)
      ) {
        throw new RequestStateError();
      }
      const decoded = Buffer.from(token, 'base64url').toString('utf8');
      const envelope: unknown = JSON.parse(decoded);
      if (!isSealedSecret(envelope)) throw new RequestStateError();
      const plaintext = await this.#secretBox.open(envelope);
      if (Buffer.byteLength(plaintext) > this.#maxTokenBytes) throw new RequestStateError();
      const parsed: unknown = JSON.parse(plaintext);
      if (!isRecord(parsed) || parsed.v !== 1) throw new RequestStateError();
      const payload = withoutVersion(parsed);
      assertPayload(payload, this.#maxRounds);
      if (payload.expiresAt <= this.#now()) {
        throw new RequestStateError('request_state_expired');
      }
      if (expectedBinding !== undefined) assertBinding(payload.binding, expectedBinding);
      return payload;
    } catch (error) {
      if (error instanceof RequestStateError) throw error;
      throw new RequestStateError();
    }
  }
}

/** Stable SHA-256 binding over JSON arguments with the legacy-only adapter envelope removed. */
export function digestMcpArguments(argumentsValue: unknown): string {
  const value =
    isRecord(argumentsValue) && Object.hasOwn(argumentsValue, LEGACY_INTERACTION_ARGUMENT)
      ? Object.fromEntries(
          Object.entries(argumentsValue).filter(([key]) => key !== LEGACY_INTERACTION_ARGUMENT),
        )
      : argumentsValue;
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}

export function assertRequestStateBinding(
  state: Pick<SealedRequestState, 'binding'>,
  expected: RequestStateBinding,
): void {
  assertBinding(state.binding, expected);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RequestStateError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  throw new RequestStateError();
}

function assertPayload(value: unknown, maxRounds: number): asserts value is SealedRequestState {
  if (
    !isRecord(value) ||
    !isResponseMap(value.responses) ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 1 ||
    (value.round as number) > maxRounds ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 1 ||
    value.nonce.length > 256 ||
    !isBinding(value.binding) ||
    !isPendingRequest(value.pendingRequest) ||
    (value.confirmation !== undefined && value.confirmation !== true) ||
    (value.pendingRequest.interaction === 'confirmation') !== (value.confirmation === true)
  ) {
    throw new RequestStateError();
  }
}

function assertBinding(actual: RequestStateBinding, expected: RequestStateBinding): void {
  for (const key of [
    'deploymentId',
    'serverVersion',
    'method',
    'target',
    'principal',
    'executionRevision',
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new RequestStateError('request_state_binding_mismatch');
    }
  }
  if (actual.argumentDigest !== expected.argumentDigest) {
    throw new RequestStateError('request_state_argument_mismatch');
  }
}

function isBinding(value: unknown): value is RequestStateBinding {
  return (
    isRecord(value) &&
    typeof value.deploymentId === 'string' &&
    typeof value.serverVersion === 'string' &&
    (value.method === 'tools/call' ||
      value.method === 'resources/read' ||
      value.method === 'prompts/get') &&
    typeof value.target === 'string' &&
    typeof value.principal === 'string' &&
    typeof value.argumentDigest === 'string' &&
    (value.executionRevision === undefined ||
      (typeof value.executionRevision === 'string' && value.executionRevision.length <= 256))
  );
}

function isResponseMap(value: unknown): value is Record<string, ElicitationResponse> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (response) =>
        isRecord(response) &&
        (response.action === 'accept' ||
          response.action === 'decline' ||
          response.action === 'cancel'),
    )
  );
}

function isPendingRequest(value: unknown): value is SealedRequestState['pendingRequest'] {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    (value.interaction === 'input' || value.interaction === 'confirmation')
  );
}

function isSealedSecret(value: unknown): value is SealedSecret {
  if (
    !isRecord(value) ||
    (value.v !== 1 && value.v !== 2) ||
    value.algo !== 'AES-256-GCM' ||
    typeof value.keyId !== 'string' ||
    typeof value.iv !== 'string' ||
    typeof value.tag !== 'string' ||
    typeof value.ct !== 'string'
  ) {
    return false;
  }
  return value.v === 1 || typeof value.wrappedDek === 'string';
}

function withoutVersion(value: Record<string, unknown>): Record<string, unknown> {
  const { v: _version, ...payload } = value;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
