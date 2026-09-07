import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
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
});
