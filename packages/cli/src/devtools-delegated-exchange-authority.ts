import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { LocalDevtoolsDelegatedExchangeAuthority as ResolvedLocalAuthority } from '@noodle-borg/service/local';
import { exportPKCS8, generateKeyPair, type JSONWebKeySet, type JWK } from 'jose';

const KEY_FILE_NAME = 'delegated-exchange-signing-key.pem';
const TRUST_STATE_FILE_NAME = 'delegated-exchange-last-issuer';
const MAX_KEY_BYTES = 16 * 1024;
const MAX_TRUST_STATE_BYTES = 512;
const WINNER_FINALIZATION_ATTEMPTS = 20;
const WINNER_FINALIZATION_RETRY_MS = 5;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

export interface LocalDevtoolsDelegatedExchangeTrustDocument {
  readonly issuer: string;
  readonly jwks: JSONWebKeySet;
  readonly trustChanged: boolean;
}

export interface LocalDevtoolsDelegatedExchangeAuthorityController {
  resolve(): Promise<ResolvedLocalAuthority>;
  trustDocument(): LocalDevtoolsDelegatedExchangeTrustDocument | undefined;
}

export class LocalDevtoolsDelegatedExchangeAuthorityError extends Error {
  readonly code:
    | 'local_delegated_exchange_key_invalid'
    | 'local_delegated_exchange_trust_state_invalid';
  readonly path: string;

  constructor(path: string, kind: 'key' | 'trust state' = 'key') {
    super(
      `Local delegated-exchange ${kind} is unsafe or unreadable. Stop Devtools, secure or remove ${JSON.stringify(path)}, then start again and update development endpoint trust.`,
    );
    this.name = 'LocalDevtoolsDelegatedExchangeAuthorityError';
    this.code =
      kind === 'key'
        ? 'local_delegated_exchange_key_invalid'
        : 'local_delegated_exchange_trust_state_invalid';
    this.path = path;
  }
}

class TransientWinnerFinalizationError extends Error {}

export function createLocalDevtoolsDelegatedExchangeAuthority(
  projectRoot: string,
): LocalDevtoolsDelegatedExchangeAuthorityController {
  const directory = join(projectRoot, '.noodle', 'devtools');
  const keyPath = join(directory, KEY_FILE_NAME);
  const trustStatePath = join(directory, TRUST_STATE_FILE_NAME);
  let resolution: Promise<ResolvedLocalAuthority> | undefined;
  let trust: LocalDevtoolsDelegatedExchangeTrustDocument | undefined;

  return {
    resolve() {
      resolution ??= resolveAuthority(directory, keyPath, trustStatePath)
        .then(({ authority, trustDocument }) => {
          trust = trustDocument;
          return authority;
        })
        .catch((error: unknown) => {
          throw toSafeError(keyPath, error);
        });
      return resolution;
    },
    trustDocument() {
      return trust;
    },
  };
}

async function resolveAuthority(
  directory: string,
  keyPath: string,
  trustStatePath: string,
): Promise<{
  readonly authority: ResolvedLocalAuthority;
  readonly trustDocument: LocalDevtoolsDelegatedExchangeTrustDocument;
}> {
  await ensureOwnerOnlyDirectory(directory);
  let previousIssuer: string | undefined;
  try {
    previousIssuer = await readPreviousIssuer(trustStatePath);
  } catch (error) {
    throw toSafeTrustStateError(trustStatePath, error);
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = await loadExistingKeyWithTransientRetry(keyPath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
    privateKeyPem = await createOrLoadWinningKey(directory, keyPath);
  }

  const resolved = await buildResolvedAuthority(privateKeyPem);
  const trustChanged =
    previousIssuer !== undefined && previousIssuer !== resolved.trustDocument.issuer;
  await persistCurrentIssuer(directory, trustStatePath, resolved.trustDocument.issuer);
  return {
    authority: resolved.authority,
    trustDocument: Object.freeze({ ...resolved.trustDocument, trustChanged }),
  };
}

async function readPreviousIssuer(trustStatePath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      trustStatePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size === 0 ||
      metadata.size > MAX_TRUST_STATE_BYTES ||
      metadata.nlink !== 1
    ) {
      throw new Error('unsafe trust state file');
    }
    const issuer = await handle.readFile('utf8');
    if (!/^urn:noodleseed:devtools:[A-Za-z0-9_-]{1,256}$/u.test(issuer)) {
      throw new Error('invalid trust state');
    }
    return issuer;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function persistCurrentIssuer(
  directory: string,
  trustStatePath: string,
  issuer: string,
): Promise<void> {
  const temporaryPath = join(
    directory,
    `.${TRUST_STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    await handle.writeFile(issuer, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, trustStatePath);
    temporaryExists = false;
  } finally {
    await handle?.close();
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The outer operation already fails closed; do not replace it with raw cleanup diagnostics.
      }
    }
  }
}

async function ensureOwnerOnlyDirectory(directory: string): Promise<void> {
  await ensureDirectoryWithoutFollowingSymlink(dirname(directory), false);
  await ensureDirectoryWithoutFollowingSymlink(directory, true);
}

async function ensureDirectoryWithoutFollowingSymlink(
  directory: string,
  requireOwnerOnly: boolean,
): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error;
    }
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || (requireOwnerOnly && (metadata.mode & 0o077) !== 0)) {
      throw new Error('unsafe directory');
    }
  } finally {
    await handle?.close();
  }
}

async function loadExistingKeyWithTransientRetry(keyPath: string): Promise<string> {
  for (let attempt = 0; attempt < WINNER_FINALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await readSecureKeyFile(keyPath);
    } catch (error) {
      if (!(error instanceof TransientWinnerFinalizationError)) {
        throw error;
      }
      if (attempt === WINNER_FINALIZATION_ATTEMPTS - 1) {
        throw error;
      }
      await delay(WINNER_FINALIZATION_RETRY_MS);
    }
  }
  throw new TransientWinnerFinalizationError();
}

async function readSecureKeyFile(keyPath: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MAX_KEY_BYTES ||
      metadata.nlink < 1
    ) {
      throw new Error('unsafe key file');
    }
    if (metadata.nlink > 1) {
      throw new TransientWinnerFinalizationError();
    }
    return await handle.readFile('utf8');
  } finally {
    await handle?.close();
  }
}

async function createOrLoadWinningKey(directory: string, keyPath: string): Promise<string> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(pair.privateKey);
  const temporaryPath = join(directory, `.${KEY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let temporaryExists = false;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    await handle.writeFile(privateKeyPem, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(temporaryPath, keyPath);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }
      await unlink(temporaryPath);
      temporaryExists = false;
      return await loadExistingKeyWithTransientRetry(keyPath);
    }

    await unlink(temporaryPath);
    temporaryExists = false;
    return privateKeyPem;
  } finally {
    await handle?.close();
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The outer operation already fails closed; do not replace it with raw cleanup diagnostics.
      }
    }
  }
}

async function buildResolvedAuthority(privateKeyPem: string): Promise<{
  readonly authority: ResolvedLocalAuthority;
  readonly trustDocument: LocalDevtoolsDelegatedExchangeTrustDocument;
}> {
  const signer = await createStaticSigningKeyProvider({ privateKeyPem });
  const published = await signer.publicJwks();
  const sourceKey = published.keys[0];
  if (published.keys.length !== 1 || !isSafePublicSigningKey(sourceKey)) {
    throw new Error('unsafe public signing key');
  }

  const publicKey = Object.freeze({
    kty: sourceKey.kty,
    n: sourceKey.n,
    e: sourceKey.e,
    kid: sourceKey.kid,
    alg: 'RS256',
    use: 'sig',
  });
  const keys = Object.freeze([publicKey]);
  const jwks = Object.freeze({ keys }) as JSONWebKeySet;
  const issuer = `urn:noodleseed:devtools:${sourceKey.kid}`;
  const trustDocument = Object.freeze({ issuer, jwks, trustChanged: false });
  return {
    authority: { issuer, signer },
    trustDocument,
  };
}

function isSafePublicSigningKey(key: JWK | undefined): key is JWK & { readonly kid: string } {
  if (
    key?.kty !== 'RSA' ||
    typeof key.n !== 'string' ||
    typeof key.e !== 'string' ||
    typeof key.kid !== 'string' ||
    key.kid.length === 0 ||
    key.alg !== 'RS256' ||
    key.use !== 'sig'
  ) {
    return false;
  }
  return PRIVATE_JWK_MEMBERS.every((member) => !(member in key));
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function toSafeError(
  keyPath: string,
  error: unknown,
): LocalDevtoolsDelegatedExchangeAuthorityError {
  if (error instanceof LocalDevtoolsDelegatedExchangeAuthorityError) {
    return error;
  }
  return new LocalDevtoolsDelegatedExchangeAuthorityError(keyPath);
}

function toSafeTrustStateError(
  trustStatePath: string,
  error: unknown,
): LocalDevtoolsDelegatedExchangeAuthorityError {
  if (error instanceof LocalDevtoolsDelegatedExchangeAuthorityError) {
    return error;
  }
  return new LocalDevtoolsDelegatedExchangeAuthorityError(trustStatePath, 'trust state');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
