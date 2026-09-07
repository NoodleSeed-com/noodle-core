import { describe, expect, it } from 'vitest';
import { secretBoxDocumentCodec } from '../src/codec.js';

describe('secretBoxDocumentCodec', () => {
  it('round-trips bytes through an async string secret box', async () => {
    const box = {
      seal: async (plaintext: string) => ({ v: 1, blob: Buffer.from(plaintext).toString('hex') }),
      open: async (sealed: { blob: string }) => Buffer.from(sealed.blob, 'hex').toString('utf8'),
    };
    const codec = secretBoxDocumentCodec(box as never);
    const sealed = await codec.seal(Buffer.from('knowledge text'));
    expect(sealed.toString('utf8')).not.toContain('knowledge text');
    expect((await codec.open(sealed)).toString('utf8')).toBe('knowledge text');
  });
});
