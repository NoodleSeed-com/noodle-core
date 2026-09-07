import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type {
  PayloadCipher,
  PayloadCipherContext,
  SealedPayload,
} from './business-information/portable.js';

interface BoundPayload {
  readonly context: PayloadCipherContext;
  readonly plaintext: string;
}

/** Adapts the service key custodian to managed-record payload encryption and binds tenant context. */
export class SecretBoxPayloadCipher implements PayloadCipher {
  readonly #secretBox: SecretBox;

  constructor(secretBox: SecretBox) {
    this.#secretBox = secretBox;
  }

  async seal(plaintext: Uint8Array, context: PayloadCipherContext): Promise<SealedPayload> {
    const sealed = await this.#secretBox.seal(
      JSON.stringify({ context, plaintext: Buffer.from(plaintext).toString('base64') }),
    );
    return {
      version: 1,
      algorithm: 'NOODLE-SECRET-BOX',
      keyId: sealed.keyId,
      ciphertext: Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url'),
    };
  }

  async open(payload: SealedPayload, context: PayloadCipherContext): Promise<Uint8Array> {
    if (payload.version !== 1 || payload.algorithm !== 'NOODLE-SECRET-BOX') {
      throw new Error('unsupported managed-record payload envelope');
    }
    const sealed = parseSealedSecret(payload.ciphertext);
    if (sealed.keyId !== payload.keyId) throw new Error('managed-record payload key mismatch');
    const opened = JSON.parse(await this.#secretBox.open(sealed)) as unknown;
    if (!isBoundPayload(opened) || !sameContext(opened.context, context)) {
      throw new Error('managed-record payload context mismatch');
    }
    return Buffer.from(opened.plaintext, 'base64');
  }
}

function parseSealedSecret(ciphertext: string): SealedSecret {
  const decoded = JSON.parse(Buffer.from(ciphertext, 'base64url').toString('utf8')) as unknown;
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    !('v' in decoded) ||
    !('algo' in decoded) ||
    !('keyId' in decoded) ||
    !('iv' in decoded) ||
    !('tag' in decoded) ||
    !('ct' in decoded)
  ) {
    throw new Error('invalid managed-record payload envelope');
  }
  return decoded as SealedSecret;
}

function isBoundPayload(value: unknown): value is BoundPayload {
  return (
    value !== null &&
    typeof value === 'object' &&
    'context' in value &&
    'plaintext' in value &&
    typeof value.plaintext === 'string' &&
    value.context !== null &&
    typeof value.context === 'object'
  );
}

function sameContext(left: PayloadCipherContext, right: PayloadCipherContext): boolean {
  return (
    left.org === right.org &&
    left.app === right.app &&
    left.env === right.env &&
    left.installationId === right.installationId &&
    left.collectionKey === right.collectionKey &&
    left.recordId === right.recordId &&
    left.revision === right.revision
  );
}
