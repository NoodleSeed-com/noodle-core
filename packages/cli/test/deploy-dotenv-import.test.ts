import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptToImportMissingDotenvConfig } from '../src/commands/deploy-dotenv-import.js';
import { prepareCanonicalDeploy } from '../src/commands/deploy-first-flow.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
let root: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noodle-deploy-dotenv-'));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function input() {
  return {
    projectRoot: root,
    missingSecrets: ['API_TOKEN', 'ABSENT_SECRET'],
    missingVariables: ['API_BASE_URL', 'ABSENT_VARIABLE'],
    serviceUrl: 'https://service.example.test',
    token: 'control-plane-token',
    target: { org: 'acme', app: 'support', env: 'prod' },
  } as const;
}

describe('deploy .env import', () => {
  it('shows names and target, then copies only matching declarations to their correct stores', async () => {
    const secretValue = 'secret-value-sentinel';
    const variableValue = 'https://api.example.test';
    writeFileSync(
      join(root, '.env'),
      [
        `API_TOKEN=${secretValue}`,
        `API_BASE_URL=${variableValue}`,
        'UNRELATED=must-not-upload',
        '',
      ].join('\n'),
    );
    const output: string[] = [];
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((request, init) => {
        requests.push({
          url: String(request),
          body: parseDeployRequestJson(init),
        });
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );

    const result = await promptToImportMissingDotenvConfig(input(), {
      confirmImport: (message) => {
        output.push(message);
        return Promise.resolve(true);
      },
      write: (message) => output.push(message),
    });

    expect(result).toEqual({
      imported: true,
      secrets: ['API_TOKEN'],
      variables: ['API_BASE_URL'],
    });
    expect(requests).toEqual([
      {
        url: 'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/variables/API_BASE_URL',
        body: { value: variableValue },
      },
      {
        url: 'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/secrets/API_TOKEN',
        body: { value: secretValue },
      },
    ]);
    const rendered = output.join('\n');
    expect(rendered).toContain('acme/support/prod');
    expect(rendered).toContain('variable API_BASE_URL');
    expect(rendered).toContain('secret API_TOKEN');
    expect(rendered).not.toContain(secretValue);
    expect(rendered).not.toContain(variableValue);
    expect(rendered).not.toContain('UNRELATED');
    expect(rendered).not.toContain('ABSENT_SECRET');
    expect(rendered).not.toContain('ABSENT_VARIABLE');
  });

  it('performs no writes when the import is declined', async () => {
    writeFileSync(join(root, '.env'), 'API_TOKEN=secret-value\n');
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    let confirmationMessage = '';

    const result = await promptToImportMissingDotenvConfig(input(), {
      confirmImport: (message) => {
        confirmationMessage = message;
        return Promise.resolve(false);
      },
      write: () => {},
    });

    expect(confirmationMessage).toBe('Copy these .env values to acme/support/prod?');
    expect(result).toEqual({ imported: false, secrets: [], variables: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not prompt or write when the project has no matching .env values', async () => {
    writeFileSync(join(root, '.env'), 'UNRELATED=value\n');
    const confirmImport = vi.fn(() => Promise.resolve(true));
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    expect(
      await promptToImportMissingDotenvConfig(input(), {
        confirmImport,
        write: () => {},
      }),
    ).toEqual({ imported: false, secrets: [], variables: [] });
    expect(confirmImport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed file before prompting or uploading and redacts its contents', async () => {
    const disclosureMarker = 'CONFIDENTIAL_IMPORT_MARKER';
    writeFileSync(join(root, '.env'), `API_TOKEN=value\n${disclosureMarker}\n`);
    const confirmImport = vi.fn(() => Promise.resolve(true));
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    let thrown: unknown;
    try {
      await promptToImportMissingDotenvConfig(input(), {
        confirmImport,
        write: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain('invalid .env syntax at line 2 (value redacted)');
    expect(String(thrown)).not.toContain(disclosureMarker);
    expect(confirmImport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('imports matching .env values with consent, then re-preflights before deploy', async () => {
    const secretValue = 'interactive-secret-sentinel';
    const variableValue = 'https://interactive.example.test';
    writeFileSync(join(root, '.env'), `API_TOKEN=${secretValue}\nAPI_BASE_URL=${variableValue}\n`);
    const calls: string[] = [];
    let preflights = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((request) => {
        const url = String(request);
        calls.push(url);
        if (url.endsWith('/deploy/preflight')) {
          preflights++;
          return Promise.resolve(
            Response.json({
              ok: true,
              ready: preflights > 1,
              target: {
                org: 'acme',
                app: 'support',
                env: 'prod',
                appState: 'will-create',
                environmentState: 'will-create',
              },
              config:
                preflights > 1
                  ? { ready: true, missingSecrets: [], missingVariables: [] }
                  : {
                      ready: false,
                      missingSecrets: ['API_TOKEN'],
                      missingVariables: ['API_BASE_URL'],
                    },
              errors:
                preflights > 1
                  ? []
                  : [
                      {
                        code: 'missing_secret',
                        path: 'secrets.API_TOKEN',
                        message: 'required secret is not configured',
                      },
                      {
                        code: 'missing_variable',
                        path: 'variables.API_BASE_URL',
                        message: 'required variable is not configured',
                      },
                    ],
            }),
          );
        }
        if (url.endsWith('/variables/API_BASE_URL') || url.endsWith('/secrets/API_TOKEN')) {
          return Promise.resolve(Response.json({ ok: true }));
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    const prompts: string[] = [];

    const preparation = await prepareCanonicalDeploy(
      {
        manifestPath: HELLO,
        serviceUrl: 'https://service.example.test',
        token: 'control-plane-token',
        target: { org: 'acme', app: 'support', env: 'prod' },
        serverVersion: '1',
        projectRoot: root,
        noPrompt: false,
        json: false,
        interactive: true,
        silent: true,
      },
      {
        confirmDotenvImport: (message) => {
          prompts.push(message);
          return Promise.resolve(true);
        },
      },
    );

    expect(preparation.ok).toBe(true);
    expect(prompts).toEqual(['Copy these .env values to acme/support/prod?']);
    expect(calls).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/variables/API_BASE_URL',
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/secrets/API_TOKEN',
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
    const rendered = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(rendered).not.toContain(secretValue);
    expect(rendered).not.toContain(variableValue);
  });

  it('keeps the existing individual-value prompt when no project .env exists', async () => {
    let preflights = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((request) => {
        const url = String(request);
        if (!url.endsWith('/deploy/preflight')) {
          throw new Error(`unexpected request: ${url}`);
        }
        preflights++;
        return Promise.resolve(
          Response.json({
            ok: true,
            ready: preflights > 1,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config:
              preflights > 1
                ? { ready: true, missingSecrets: [], missingVariables: [] }
                : {
                    ready: false,
                    missingSecrets: ['API_TOKEN'],
                    missingVariables: ['API_BASE_URL'],
                  },
            errors:
              preflights > 1
                ? []
                : [
                    {
                      code: 'missing_secret',
                      path: 'secrets.API_TOKEN',
                      message: 'required secret is not configured',
                    },
                    {
                      code: 'missing_variable',
                      path: 'variables.API_BASE_URL',
                      message: 'required variable is not configured',
                    },
                  ],
          }),
        );
      }),
    );
    const promptMissingConfig = vi.fn(() => Promise.resolve());

    const preparation = await prepareCanonicalDeploy(
      {
        manifestPath: HELLO,
        serviceUrl: 'https://service.example.test',
        token: 'control-plane-token',
        target: { org: 'acme', app: 'support', env: 'prod' },
        serverVersion: '1',
        projectRoot: root,
        noPrompt: false,
        json: false,
        interactive: true,
        silent: true,
      },
      { promptMissingConfig },
    );

    expect(preparation.ok).toBe(true);
    expect(promptMissingConfig).toHaveBeenCalledWith({
      missingSecrets: ['API_TOKEN'],
      missingVariables: ['API_BASE_URL'],
      serviceUrl: 'https://service.example.test',
      token: 'control-plane-token',
      target: { org: 'acme', app: 'support', env: 'prod' },
    });
    expect(preflights).toBe(2);
  });

  it('returns a redacted, deploy-specific repair when project .env is malformed', async () => {
    const disclosureMarker = 'CONFIDENTIAL_PREFLIGHT_DOTENV_MARKER';
    writeFileSync(join(root, '.env'), `API_TOKEN=value\n${disclosureMarker}\n`);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((request) => {
        const url = String(request);
        calls.push(url);
        return Promise.resolve(
          Response.json({
            ok: true,
            ready: false,
            target: {
              org: 'acme',
              app: 'support',
              env: 'prod',
              appState: 'will-create',
              environmentState: 'will-create',
            },
            config: {
              ready: false,
              missingSecrets: ['API_TOKEN'],
              missingVariables: [],
            },
            errors: [
              {
                code: 'missing_secret',
                path: 'secrets.API_TOKEN',
                message: 'required secret is not configured',
              },
            ],
          }),
        );
      }),
    );
    const confirmDotenvImport = vi.fn(() => Promise.resolve(true));

    const preparation = await prepareCanonicalDeploy(
      {
        manifestPath: HELLO,
        serviceUrl: 'https://service.example.test',
        token: 'control-plane-token',
        target: { org: 'acme', app: 'support', env: 'prod' },
        serverVersion: '1',
        projectRoot: root,
        noPrompt: false,
        json: false,
        interactive: true,
        silent: true,
      },
      { confirmDotenvImport },
    );

    expect(preparation).toMatchObject({
      ok: false,
      error: {
        code: 'deploy_preflight_failed',
        message: 'invalid .env syntax at line 2 (value redacted)',
        fix: 'Fix the reported .env syntax line, then retry the deploy.',
        next: 'noodle deploy',
      },
    });
    expect(JSON.stringify(preparation)).not.toContain(disclosureMarker);
    expect(confirmDotenvImport).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
  });
});
