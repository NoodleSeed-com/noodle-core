import type {
  PayloadCipher,
  PayloadCipherContext,
  SealedPayload,
} from '../src/business-information/contracts.js';

/** Deterministic test-only encoding. Production adapters must supply authenticated encryption. */
export class TestPayloadCipher implements PayloadCipher {
  seal(plaintext: Uint8Array, context: PayloadCipherContext): Promise<SealedPayload> {
    return Promise.resolve({
      version: 1,
      algorithm: 'test-only-base64',
      keyId: context.installationId,
      ciphertext: Buffer.from(plaintext).toString('base64'),
    });
  }

  open(payload: SealedPayload, context: PayloadCipherContext): Promise<Uint8Array> {
    if (payload.algorithm !== 'test-only-base64' || payload.keyId !== context.installationId) {
      throw new Error('test payload cipher context mismatch');
    }
    return Promise.resolve(Buffer.from(payload.ciphertext, 'base64'));
  }
}
