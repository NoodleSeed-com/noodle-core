import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  SecretDecryptError,
  staticMasterKeyProvider,
  type WrappingMasterKey,
} from '../src/index.js';

const keyOf = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const box = (fill = 1): SecretBox => new SecretBox(staticMasterKeyProvider(keyOf(fill)));

/**
 * A KMS-shaped {@link WrappingMasterKey} stand-in: it wraps the DEK by AES-256-GCM-encrypting it under a
 * fixed test KEK (the same envelope shape a real custodian uses), so wrong-KEK and tamper behaviour are
 * exercised without a network. A different `kek` byte is a different (wrong) custodian.
 */
function fakeWrappingProvider(
  kek = Buffer.alloc(32, 5),
  keyId = 'fake-kms-key',
): WrappingMasterKey {
  return {
    kind: 'wrapping',
    keyId,
    async wrapDek(dek) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', kek, iv);
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]); // iv | tag | ct
    },
    async unwrapDek(wrapped) {
      const d = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12));
      d.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
    },
  };
}

describe('SecretBox v1 — static key (AES-256-GCM secret-at-rest)', () => {
  it('round-trips a value: seal then open', async () => {
    const b = box();
    for (const plain of ['tok-123', '', 'únïcödé-🔒', 'x'.repeat(4096), 'a"b\\c\nd']) {
      expect(await b.open(await b.seal(plain))).toBe(plain);
    }
  });

  it('uses a fresh random iv/ciphertext each seal but opens to the same value', async () => {
    const b = box();
    const a = await b.seal('same');
    const c = await b.seal('same');
    expect(a.iv).not.toBe(c.iv);
    expect(a.ct).not.toBe(c.ct);
    expect(await b.open(a)).toBe('same');
    expect(await b.open(c)).toBe('same');
  });

  it('the sealed envelope is v1 and contains no plaintext', async () => {
    const sealed = await box().seal('tok-do-not-leak-9876');
    expect(JSON.stringify(sealed)).not.toContain('tok-do-not-leak-9876');
    expect(sealed.algo).toBe('AES-256-GCM');
    expect(sealed.v).toBe(1);
  });

  it('fails closed (SecretDecryptError) with a WRONG key — and leaks no plaintext in the error', async () => {
    const sealed = await box(1).seal('tok-do-not-leak-9876');
    const wrong = box(2);
    await expect(wrong.open(sealed)).rejects.toThrow(SecretDecryptError);
    try {
      await wrong.open(sealed);
    } catch (error) {
      expect((error as Error).message).not.toContain('tok-do-not-leak-9876');
    }
  });

  it('fails closed on a tampered tag or ciphertext (GCM integrity)', async () => {
    const b = box();
    const sealed = await b.seal('secret');
    await expect(
      b.open({ ...sealed, ct: Buffer.from('tampered').toString('base64') }),
    ).rejects.toThrow(SecretDecryptError);
    await expect(
      b.open({ ...sealed, tag: Buffer.alloc(16, 0).toString('base64') }),
    ).rejects.toThrow(SecretDecryptError);
  });

  it('rejects a master key that is not 32 bytes (fail closed at construction)', () => {
    expect(() => staticMasterKeyProvider(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => staticMasterKeyProvider('')).toThrow(/32 bytes/);
  });
});

describe('SecretBox v2 — wrapping provider (envelope encryption, ADR 0037)', () => {
  it('seals v2 with a wrappedDek and round-trips, leaking no plaintext', async () => {
    const b = new SecretBox(fakeWrappingProvider());
    const sealed = await b.seal('tok-do-not-leak-kms');
    expect(sealed.v).toBe(2);
    expect(sealed.algo).toBe('AES-256-GCM');
    expect(sealed.keyId).toBe('fake-kms-key');
    if (sealed.v === 2) expect(sealed.wrappedDek.length).toBeGreaterThan(0);
    expect(JSON.stringify(sealed)).not.toContain('tok-do-not-leak-kms');
    expect(await b.open(sealed)).toBe('tok-do-not-leak-kms');
  });

  it('uses a fresh per-record DEK each seal (distinct wrappedDek + ciphertext)', async () => {
    const b = new SecretBox(fakeWrappingProvider());
    const a = await b.seal('same');
    const c = await b.seal('same');
    if (a.v === 2 && c.v === 2) expect(a.wrappedDek).not.toBe(c.wrappedDek);
    expect(a.ct).not.toBe(c.ct);
    expect(await b.open(a)).toBe('same');
    expect(await b.open(c)).toBe('same');
  });

  it('fails closed with a WRONG KEK (the DEK cannot be unwrapped)', async () => {
    const sealed = await new SecretBox(fakeWrappingProvider(Buffer.alloc(32, 5))).seal('tok');
    const wrongKek = new SecretBox(fakeWrappingProvider(Buffer.alloc(32, 9)));
    await expect(wrongKek.open(sealed)).rejects.toThrow(SecretDecryptError);
  });

  it('fails closed on a tampered blob ciphertext (the DEK still unwraps; GCM catches the blob)', async () => {
    const b = new SecretBox(fakeWrappingProvider());
    const sealed = await b.seal('secret');
    await expect(
      b.open({ ...sealed, ct: Buffer.from('tampered').toString('base64') }),
    ).rejects.toThrow(SecretDecryptError);
  });

  it('fails closed when the v2 header keyId is tampered (bound as GCM AAD)', async () => {
    const b = new SecretBox(fakeWrappingProvider());
    const sealed = await b.seal('secret');
    // Without the AAD binding this would decrypt fine (keyId is not used for key selection); the AAD makes
    // any header tampering tamper-evident.
    await expect(b.open({ ...sealed, keyId: 'attacker-swapped-key-id' })).rejects.toThrow(
      SecretDecryptError,
    );
  });
});

describe('SecretBox — version/provider mismatch fails closed', () => {
  it('a v2 record cannot be opened by a static provider', async () => {
    const v2 = await new SecretBox(fakeWrappingProvider()).seal('tok');
    await expect(box().open(v2)).rejects.toThrow(SecretDecryptError);
  });

  it('a v1 record cannot be opened by a wrapping provider', async () => {
    const v1 = await box().seal('tok');
    await expect(new SecretBox(fakeWrappingProvider()).open(v1)).rejects.toThrow(
      SecretDecryptError,
    );
  });
});
