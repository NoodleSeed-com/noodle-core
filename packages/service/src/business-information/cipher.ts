import type {
  ManagedRequestContent,
  ManagedRequestOrigin,
  PayloadCipher,
  PayloadCipherContext,
  SealedPayload,
} from './contracts.js';
import { validateManagedPayload, validateScalar } from './validation.js';

interface StoredRecordContent {
  readonly content: ManagedRequestContent;
  readonly originReference?: string;
}

export async function sealRecordContent(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  content: ManagedRequestContent,
  origin: ManagedRequestOrigin,
): Promise<SealedPayload> {
  const stored: StoredRecordContent = {
    content,
    ...(origin.reference === undefined ? {} : { originReference: origin.reference }),
  };
  return validateSealedPayload(
    await cipher.seal(new TextEncoder().encode(JSON.stringify(stored)), context),
  );
}

export async function openRecordContent(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  sealed: unknown,
): Promise<StoredRecordContent> {
  const plaintext = await cipher.open(validateSealedPayload(sealed), context);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(plaintext));
  } catch {
    throw new Error('managed request ciphertext did not open to valid JSON');
  }
  return validateStoredContent(parsed);
}

export async function sealActivityContent(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  content: ManagedRequestContent,
): Promise<SealedPayload> {
  return validateSealedPayload(
    await cipher.seal(new TextEncoder().encode(JSON.stringify({ content })), context),
  );
}

export async function openActivityContent(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  sealed: unknown,
): Promise<ManagedRequestContent> {
  const opened = await openRecordContent(cipher, context, sealed);
  return opened.content;
}

function validateStoredContent(value: unknown): StoredRecordContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('managed request content is invalid');
  }
  const input = value as { content?: unknown; originReference?: unknown };
  if (typeof input.content !== 'object' || input.content === null || Array.isArray(input.content)) {
    throw new Error('managed request content is invalid');
  }
  const rawContent = input.content as { payload?: unknown; notes?: unknown };
  const payload = validateManagedPayload(rawContent.payload);
  if (!Array.isArray(rawContent.notes) || rawContent.notes.length > 50) {
    throw new Error('managed request notes are invalid');
  }
  const notes = rawContent.notes.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('managed request note is invalid');
    }
    const note = value as Record<string, unknown>;
    if (
      typeof note.id !== 'string' ||
      typeof note.text !== 'string' ||
      typeof note.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(note.createdAt)) ||
      typeof note.createdBySubject !== 'string'
    ) {
      throw new Error('managed request note is invalid');
    }
    validateManagedPayload({ note: note.text });
    return {
      id: validateScalar('note id', note.id, 128),
      text: note.text,
      createdAt: new Date(note.createdAt).toISOString(),
      createdBySubject: validateScalar('note actor subject', note.createdBySubject, 256),
    };
  });
  return {
    content: { payload, notes },
    ...(input.originReference === undefined
      ? {}
      : {
          originReference: validateScalar('origin reference', String(input.originReference), 256),
        }),
  };
}

function validateSealedPayload(value: unknown): SealedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('payload cipher returned an invalid envelope');
  }
  const input = value as Partial<SealedPayload>;
  if (
    input.version !== 1 ||
    typeof input.algorithm !== 'string' ||
    typeof input.keyId !== 'string' ||
    typeof input.ciphertext !== 'string'
  ) {
    throw new Error('payload cipher returned an invalid envelope');
  }
  return {
    version: 1,
    algorithm: validateScalar('cipher algorithm', input.algorithm, 128),
    keyId: validateScalar('cipher key id', input.keyId, 256),
    ciphertext: validateScalar('ciphertext', input.ciphertext, 512 * 1024),
  };
}
