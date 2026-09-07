import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The AES-256-GCM ciphertext components (all base64) shared by the sealed envelope and DEK wrapping. */
interface AesGcmParts {
  /** base64; 12 random bytes, fresh per encryption. */
  readonly iv: string;
  /** base64 GCM authentication tag (tamper-evident). */
  readonly tag: string;
  /** base64 ciphertext. */
  readonly ct: string;
}

/**
 * A serializable, AES-256-GCM-sealed secret value. Holds **no** plaintext — only base64 IV/tag/ciphertext,
 * plus the key id + algorithm (and, for v2, the wrapped data key) so the open path can select the right key
 * across mixed-vintage records during a migration.
 *
 * - **v1** (ADR 0028): the blob is encrypted **directly** with a static 32-byte master key. Emitted by
 *   {@link staticMasterKeyProvider} (dev/offline); still fully readable.
 * - **v2** (ADR 0037): **envelope encryption** — a fresh per-record 32-byte data key (DEK) encrypts the
 *   blob, and the KEK custodian (e.g. Cloud KMS) wraps the DEK (`wrappedDek`). The KEK never enters the
 *   process. Emitted by a {@link WrappingMasterKey} provider.
 */
export type SealedSecret = SealedSecretV1 | SealedSecretV2;

export interface SealedSecretV1 extends AesGcmParts {
  readonly v: 1;
  readonly algo: 'AES-256-GCM';
  /** The static key id (e.g. `'static'`) that encrypted the blob. */
  readonly keyId: string;
}

export interface SealedSecretV2 extends AesGcmParts {
  readonly v: 2;
  readonly algo: 'AES-256-GCM';
  /** The KEK id (e.g. a Cloud KMS cryptoKey resource name) that wrapped {@link wrappedDek}. */
  readonly keyId: string;
  /** base64 KEK-ciphertext of the 32-byte DEK that encrypted the blob ({@link AesGcmParts.ct}). */
  readonly wrappedDek: string;
}

/**
 * Thrown when a {@link SecretBox} cannot decrypt — a wrong/missing key or KEK, tampered ciphertext, or a
 * record/provider version mismatch. Never includes the plaintext or the ciphertext in its message.
 */
export class SecretDecryptError extends Error {
  constructor(message = 'failed to decrypt secret (wrong key or tampered ciphertext)') {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/**
 * Custodian of the key-encrypting key (KEK). Two shapes (ADR 0037), discriminated by `kind`:
 *
 * - {@link StaticMasterKey} — a raw 32-byte key held in-process (dev/offline); {@link SecretBox} seals
 *   **v1** (the blob is encrypted directly with the key).
 * - {@link WrappingMasterKey} — the KEK never leaves a custodian (e.g. Cloud KMS); it only wrap/unwraps a
 *   per-record DEK, so {@link SecretBox} seals **v2** (envelope encryption). Async — the custodian is a
 *   network call.
 *
 * `keyId` is stamped into each {@link SealedSecret} so the right key can be selected to open it later.
 */
export type MasterKeyProvider = StaticMasterKey | WrappingMasterKey;

export interface StaticMasterKey {
  readonly kind: 'static';
  readonly keyId: string;
  /** Exactly 32 bytes. Held in-process — dev/offline only. */
  key(): Buffer;
}

export interface WrappingMasterKey {
  readonly kind: 'wrapping';
  readonly keyId: string;
  /** Wrap (encrypt) a 32-byte DEK with the KEK. The KEK never leaves the custodian. */
  wrapDek(dek: Buffer): Promise<Buffer>;
  /** Unwrap (decrypt) a previously wrapped DEK. Throws if the KEK cannot open it. */
  unwrapDek(wrapped: Buffer): Promise<Buffer>;
}

/**
 * A {@link StaticMasterKey} backed by a base64-encoded 32-byte key (e.g. from an env var). Validates the
 * length eagerly: an absent/short/invalid key throws **here**, so a misconfigured deployment fails closed
 * rather than persisting or reading secrets in the clear.
 */
export function staticMasterKeyProvider(base64Key: string, keyId = 'static'): StaticMasterKey {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error(`secret master key must decode to 32 bytes (base64); got ${key.length}`);
  }
  return { kind: 'static', keyId, key: () => key };
}

/**
 * Reversible envelope encryption for secret values at rest (Slice 26, ADR 0028; KEK custody ADR 0037).
 * Connector secrets must be reproduced verbatim to send downstream, so they are **encrypted, not hashed**.
 * AES-256-GCM via
 * `node:crypto`, a fresh random IV per seal, and the GCM tag authenticates the ciphertext.
 *
 * `seal`/`open` are **async** because a wrapping (KMS) provider round-trips to the custodian; a static
 * provider resolves immediately. The live in-memory broker still holds plaintext — only the *persisted
 * projection* is sealed.
 */
export class SecretBox {
  readonly #provider: MasterKeyProvider;

  constructor(provider: MasterKeyProvider) {
    this.#provider = provider;
  }

  /**
   * Seal a plaintext. A static provider emits **v1** (blob encrypted directly with its key — byte-identical
   * to ADR 0028); a wrapping provider emits **v2** (a fresh per-record DEK encrypts the blob, the KEK wraps
   * the DEK).
   */
  async seal(plaintext: string): Promise<SealedSecret> {
    if (this.#provider.kind === 'static') {
      return {
        v: 1,
        algo: 'AES-256-GCM',
        keyId: this.#provider.keyId,
        ...aesEncrypt(this.#provider.key(), plaintext),
      };
    }
    const dek = randomBytes(32);
    const wrappedDek = (await this.#provider.wrapDek(dek)).toString('base64');
    // Bind the v2 header (version, algo, keyId, wrappedDek) into the GCM tag as AAD so the record is
    // self-describing and tamper-evident on those fields — not just transitively via the unique DEK.
    const parts = aesEncrypt(dek, plaintext, v2Aad(this.#provider.keyId, wrappedDek));
    return { v: 2, algo: 'AES-256-GCM', keyId: this.#provider.keyId, wrappedDek, ...parts };
  }

  /**
   * Open a {@link SealedSecret}. Dispatches on its version against the provider: **v1** needs the static
   * key; **v2** unwraps the per-record DEK via the wrapping provider. Any failure — wrong key/KEK, tampered
   * ciphertext, an unavailable KMS, or a version/provider mismatch — is normalized to
   * {@link SecretDecryptError}, whose message leaks neither plaintext nor ciphertext.
   */
  async open(sealed: SealedSecret): Promise<string> {
    try {
      if (sealed.v === 2) {
        if (this.#provider.kind !== 'wrapping') {
          throw new Error('a v2 (KMS-wrapped) record requires a wrapping master-key provider');
        }
        const dek = await this.#provider.unwrapDek(Buffer.from(sealed.wrappedDek, 'base64'));
        return aesDecrypt(dek, sealed, v2Aad(sealed.keyId, sealed.wrappedDek));
      }
      if (this.#provider.kind !== 'static') {
        throw new Error('a v1 (static-key) record requires the static master-key provider');
      }
      return aesDecrypt(this.#provider.key(), sealed);
    } catch {
      // Normalize every failure (wrong key, bad tag, KMS error, version mismatch) to one opaque error.
      throw new SecretDecryptError();
    }
  }
}

/**
 * The v2 additional authenticated data: the header fields bound into the GCM tag so any tampering of the
 * version/algo/keyId/wrappedDek is caught on open. A deterministic, fixed-key-order JSON so `seal` and
 * `open` reconstruct byte-identical AAD. (v1 uses no AAD, staying byte-identical to ADR 0028.)
 */
function v2Aad(keyId: string, wrappedDek: string): Buffer {
  return Buffer.from(JSON.stringify({ v: 2, algo: 'AES-256-GCM', keyId, wrappedDek }), 'utf8');
}

/** AES-256-GCM encrypt `plaintext` under `key` (32 bytes), optionally bound to `aad`. */
function aesEncrypt(key: Buffer, plaintext: string, aad?: Buffer): AesGcmParts {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** AES-256-GCM decrypt {@link AesGcmParts} under `key`; throws on a wrong key, wrong `aad`, or tampering. */
function aesDecrypt(key: Buffer, parts: AesGcmParts, aad?: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts.iv, 'base64'), {
    authTagLength: 16,
  });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(parts.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(parts.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}
