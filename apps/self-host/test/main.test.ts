import { generateKeyPairSync } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import { SelfHostAdminGate } from '../src/admin-gate.js';
import { startSelfHostService } from '../src/main.js';

const DATABASE_URL = 'postgresql://noodle:database-password@database:5432/noodle';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ADMIN_TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const ASSET_IDENTITY_SALT = Buffer.alloc(32, 9).toString('base64url');
const SIGNING_KEY_BASE64 = Buffer.from(
  generateKeyPairSync('rsa', {
    modulusLength: 2_048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
).toString('base64');

function validEnvironment(): Record<string, string> {
  return {
    DATABASE_URL,
    NOODLE_SECRET_MASTER_KEY: MASTER_KEY,
    NOODLE_SELF_HOST_ADMIN_TOKEN: ADMIN_TOKEN,
    NOODLE_ASSET_ROOT: '/var/lib/noodle/assets',
    NOODLE_ASSET_IDENTITY_SALT: ASSET_IDENTITY_SALT,
  };
}

function recordingLogger() {
  const records: Array<{ event: string; fields?: Readonly<Record<string, unknown>> }> = [];
  const logger = {
    level: 'info' as const,
    log(_level: string, event: string, fields?: Readonly<Record<string, unknown>>) {
      records.push({ event, ...(fields === undefined ? {} : { fields }) });
    },
    debug(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('debug', event, fields);
    },
    info(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('info', event, fields);
    },
    warn(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('warn', event, fields);
    },
    error(event: string, fields?: Readonly<Record<string, unknown>>) {
      this.log('error', event, fields);
    },
    child() {
      return logger;
    },
  };
  return { logger, records };
}

function expectSecretAbsent(output: string, secret: string): void {
  expect(output.includes(secret)).toBe(false);
}

describe('startSelfHostService', () => {
  it('boots PostgreSQL with the dual protocol, eager recovery, and the self-host admin gate only', async () => {
    let receivedOptions: Readonly<Record<string, unknown>> | undefined;
    const { logger, records } = recordingLogger();

    await startSelfHostService(validEnvironment(), {
      logger,
      serve: async (options) => {
        receivedOptions = options;
        return { close: async () => undefined };
      },
      onSigterm: () => undefined,
      setExitCode: () => undefined,
    });

    expect(Object.keys(receivedOptions ?? {}).sort()).toEqual([
      'assetPublicBaseUrl',
      'databaseUrl',
      'deployGate',
      'host',
      'logger',
      'mcpProtocolMode',
      'modules',
      'port',
      'publicBaseUrl',
      'secretMasterKey',
      'warmAll',
    ]);
    expect(receivedOptions?.databaseUrl === DATABASE_URL).toBe(true);
    expect(receivedOptions?.secretMasterKey === MASTER_KEY).toBe(true);
    expect(receivedOptions).toMatchObject({
      host: '0.0.0.0',
      port: 8787,
      assetPublicBaseUrl: 'http://localhost:8787',
      publicBaseUrl: 'http://localhost:8787',
      warmAll: true,
      mcpProtocolMode: 'dual',
      logger,
    });
    expect(receivedOptions?.deployGate).toBeInstanceOf(SelfHostAdminGate);
    expect(receivedOptions?.modules).toMatchObject([
      {
        name: '@noodle-borg/asset-storage',
        apiVersion: 2,
      },
    ]);
    expect(records).toEqual([
      {
        event: 'self_host.ready',
        fields: {
          host: '0.0.0.0',
          port: 8787,
          persistence: 'postgresql',
          protocolMode: 'dual',
        },
      },
    ]);
  });

  it('rejects invalid configuration before binding or producing secret-bearing output', async () => {
    const workosSecret = 'workos-secret-that-must-not-leak';
    const { logger, records } = recordingLogger();
    let serveCalls = 0;
    let errorMessage = '';

    try {
      await startSelfHostService(
        { ...validEnvironment(), NOODLE_OAUTH_WORKOS_API_KEY: workosSecret },
        {
          logger,
          serve: async () => {
            serveCalls += 1;
            return { close: async () => undefined };
          },
          onSigterm: () => undefined,
          setExitCode: () => undefined,
        },
      );
      throw new Error('invalid self-host configuration unexpectedly booted');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(serveCalls).toBe(0);
    expect(errorMessage).toContain('NOODLE_OAUTH_WORKOS_API_KEY');
    const observableOutput = inspect({ errorMessage, records });
    expectSecretAbsent(observableOutput, workosSecret);
    expectSecretAbsent(observableOutput, DATABASE_URL);
    expectSecretAbsent(observableOutput, MASTER_KEY);
    expectSecretAbsent(observableOutput, ADMIN_TOKEN);
  });

  it.each([
    [
      'NOODLE_OAUTH_ISSUER',
      {
        NOODLE_OAUTH_ISSUER: 'http://idp.example.test',
        NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
      },
      'http://idp.example.test',
    ],
    [
      'NOODLE_OAUTH_JWKS_URI',
      {
        NOODLE_OAUTH_ISSUER: 'https://idp.example.test',
        NOODLE_OAUTH_JWKS_URI: 'http://keys.example.test/.well-known/jwks.json',
      },
      'http://keys.example.test/.well-known/jwks.json',
    ],
    [
      'NOODLE_OAUTH_GOOGLE_REDIRECT_URI',
      {
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_SIGNING_KEY_BASE64: SIGNING_KEY_BASE64,
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'http://noodle.example.test/oauth/google/callback',
      },
      'http://noodle.example.test/oauth/google/callback',
    ],
  ])('rejects non-loopback HTTP %s before serve without disclosing its value', async (variableName, ownerAuth, value) => {
    const { logger, records } = recordingLogger();
    let serveCalls = 0;
    let errorMessage = '';

    try {
      await startSelfHostService(
        { ...validEnvironment(), ...ownerAuth },
        {
          logger,
          serve: async () => {
            serveCalls += 1;
            return { close: async () => undefined };
          },
          onSigterm: () => undefined,
          setExitCode: () => undefined,
        },
      );
      throw new Error('insecure OAuth configuration unexpectedly booted');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(serveCalls).toBe(0);
    expect(errorMessage).toContain(variableName);
    expectSecretAbsent(inspect({ errorMessage, records }), value);
  });

  it('closes the returned service exactly once when SIGTERM is delivered repeatedly', async () => {
    const { logger } = recordingLogger();
    let closeCalls = 0;
    const exitCodes: number[] = [];
    let sigtermHandler: (() => Promise<void>) | undefined;

    await startSelfHostService(validEnvironment(), {
      logger,
      serve: async () => ({
        close: async () => {
          closeCalls += 1;
        },
      }),
      onSigterm: (handler) => {
        sigtermHandler = handler;
      },
      setExitCode: (code) => exitCodes.push(code),
    });

    if (sigtermHandler === undefined) throw new Error('SIGTERM handler was not registered');
    await sigtermHandler();
    await sigtermHandler();

    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([]);
  });

  it('keeps one rejecting close observable and sets a redacted failure exit status', async () => {
    const closeError = new Error(`shutdown failed with ${ADMIN_TOKEN}`);
    const { logger, records } = recordingLogger();
    const exitCodes: number[] = [];
    let closeCalls = 0;
    let sigtermHandler: (() => Promise<void>) | undefined;

    await startSelfHostService(validEnvironment(), {
      logger,
      serve: async () => ({
        close: async () => {
          closeCalls += 1;
          throw closeError;
        },
      }),
      onSigterm: (handler) => {
        sigtermHandler = handler;
      },
      setExitCode: (code) => exitCodes.push(code),
    });

    if (sigtermHandler === undefined) throw new Error('SIGTERM handler was not registered');
    const first = sigtermHandler();
    const second = sigtermHandler();

    expect(first).toBe(second);
    await expect(first).rejects.toBe(closeError);
    await expect(second).rejects.toBe(closeError);
    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(records.at(-1)).toEqual({
      event: 'self_host.stop_failed',
      fields: {
        host: '0.0.0.0',
        port: 8787,
        persistence: 'postgresql',
        protocolMode: 'dual',
      },
    });
    expectSecretAbsent(inspect(records), closeError.message);
    expectSecretAbsent(inspect(records), ADMIN_TOKEN);
  });
});
