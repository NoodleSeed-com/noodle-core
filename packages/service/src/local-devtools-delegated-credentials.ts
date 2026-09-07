import { parseLegacyTenantMcpPath } from '@noodle-borg/module';
import type {
  DelegatedCredentialLookup,
  DelegatedCredentialRecord,
  OAuthStore,
} from './oauth/store.js';

const MAX_SUBJECT_LENGTH = 1_024;
const MAX_REFRESH_TOKEN_LENGTH = 1024 * 1024;

export type LocalDevtoolsDelegatedProvider = 'firebase' | 'microsoft';

export interface LocalDevtoolsDelegatedCredential {
  readonly resource: string;
  readonly provider: LocalDevtoolsDelegatedProvider;
  readonly subject: string;
  readonly refreshToken: string;
}

/** In-process-only write port. It is never mounted as an HTTP route or serialized to the browser. */
export interface LocalDevtoolsDelegatedCredentialSink {
  setCredential(input: LocalDevtoolsDelegatedCredential): Promise<void>;
  clearResource(resource: string): void;
}

export interface LocalDevtoolsDelegatedCredentialSource {
  readonly store: Pick<OAuthStore, 'getDelegatedCredential' | 'putDelegatedCredential'>;
  bind(serviceOrigin: string): LocalDevtoolsDelegatedCredentialSink;
}

/** Create a process-memory credential source shared by the local auth session and the existing broker. */
export function createLocalDevtoolsDelegatedCredentialSource(): LocalDevtoolsDelegatedCredentialSource {
  const records = new Map<string, DelegatedCredentialRecord>();
  let boundOrigin: string | undefined;

  const store: Pick<OAuthStore, 'getDelegatedCredential' | 'putDelegatedCredential'> = {
    getDelegatedCredential: (lookup) => Promise.resolve(records.get(keyFor(lookup))),
    putDelegatedCredential: (record) => {
      const key = keyFor(record);
      if (!records.has(key)) {
        return Promise.reject(
          new Error('local Devtools broker cannot create an unbound delegated credential'),
        );
      }
      assertMemoryEnvelope(record);
      records.set(key, record);
      return Promise.resolve();
    },
  };

  return {
    store,
    bind(serviceOrigin) {
      const origin = normalizeServiceOrigin(serviceOrigin);
      if (boundOrigin !== undefined && boundOrigin !== origin) {
        throw new Error('local Devtools credential source is already bound');
      }
      boundOrigin = origin;
      return {
        async setCredential(input) {
          assertCredential(input, origin);
          records.set(keyFor(input), {
            resource: input.resource,
            provider: input.provider,
            subject: input.subject,
            credential: { enc: 'none', values: { token: input.refreshToken } },
            updatedAt: new Date().toISOString(),
          });
        },
        clearResource(resource) {
          if (!isBoundResource(resource, origin)) return;
          for (const [key, record] of records) {
            if (record.resource === resource) records.delete(key);
          }
        },
      };
    },
  };
}

function assertCredential(input: LocalDevtoolsDelegatedCredential, origin: string): void {
  if (!isBoundResource(input.resource, origin)) {
    throw new Error('local Devtools delegated credential must target this loopback MCP service');
  }
  if (input.provider !== 'firebase' && input.provider !== 'microsoft') {
    throw new Error('unsupported local Devtools delegated credential provider');
  }
  if (
    input.subject.length === 0 ||
    input.subject.length > MAX_SUBJECT_LENGTH ||
    input.subject.trim() !== input.subject
  ) {
    throw new Error('local Devtools delegated credential subject is invalid');
  }
  if (input.refreshToken.length === 0 || input.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
    throw new Error('local Devtools delegated refresh token is invalid');
  }
}

function assertMemoryEnvelope(record: DelegatedCredentialRecord): void {
  const token = record.credential.enc === 'none' ? record.credential.values.token : undefined;
  if (token === undefined || token.length === 0 || token.length > MAX_REFRESH_TOKEN_LENGTH) {
    throw new Error('local Devtools delegated credential must remain an in-memory token envelope');
  }
}

function isBoundResource(resource: string, origin: string): boolean {
  try {
    const url = new URL(resource);
    return (
      url.origin === origin &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      parseLegacyTenantMcpPath(url.pathname) !== undefined
    );
  } catch {
    return false;
  }
}

function normalizeServiceOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !isLoopback(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('local Devtools delegated credential source requires a loopback HTTP origin');
  }
  return url.origin;
}

function keyFor(input: DelegatedCredentialLookup): string {
  return JSON.stringify([input.resource, input.provider, input.subject]);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
