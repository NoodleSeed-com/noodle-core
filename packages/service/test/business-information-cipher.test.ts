import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { validateSealedPayload } from '../src/business-information/cipher.js';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';

const context = {
  org: 'acme',
  app: 'travel',
  env: 'prod',
  installationId: 'ins_1',
  collectionKey: 'travel_requests',
  recordId: 'rec_1',
  revision: 1,
} as const;

describe('SecretBoxPayloadCipher', () => {
  it('round-trips bytes while binding the complete record context', async () => {
    const cipher = new SecretBoxPayloadCipher(
      new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 7).toString('base64'))),
    );
    const input = new TextEncoder().encode('{"summary":"private"}');
    const sealed = await cipher.seal(input, context);

    await expect(cipher.open(sealed, context).then((value) => [...value])).resolves.toEqual([
      ...input,
    ]);
    await expect(cipher.open(sealed, { ...context, recordId: 'rec_2' })).rejects.toThrow(
      'context mismatch',
    );
    expect(sealed.ciphertext).not.toContain('private');
  });

  it('keeps the record envelope bound when another owner needs a larger explicit bound', () => {
    const envelope = {
      version: 1,
      algorithm: 'fixture',
      keyId: 'key',
      ciphertext: 'x'.repeat(512 * 1024 + 1),
    };
    expect(() => validateSealedPayload(envelope)).toThrow('ciphertext');
    expect(validateSealedPayload(envelope, 1024 * 1024).ciphertext.length).toBe(512 * 1024 + 1);
    expect(() =>
      validateSealedPayload({ ...envelope, ciphertext: 'line\nbreak' }, 1024 * 1024),
    ).toThrow('ciphertext');
  });
});
