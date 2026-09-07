import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileManifest,
  InMemoryCatalog,
  validateJsonSchemaWithDefaults,
} from '../../../packages/compiler/src/index.js';
import { compileConnectors } from '../../../packages/connector-defs/src/index.js';
import {
  type CredentialBroker,
  type CredentialRequest,
  type DownstreamCredential,
  executePreparedTool,
  executeTool,
  InMemoryConnectorRegistry,
  isConfirmationRequired,
  prepareToolForConfirmation,
} from '../../../packages/runtime/src/index.js';
import app, { PERSONAL_ACCOUNT, WORK_ACCOUNT } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));

async function compiledFixture() {
  const catalog = structuredClone(app.toConnectorCatalog());
  if (catalog === undefined) throw new Error('expected connector catalog');
  for (const connector of catalog.connectors) {
    if ('http' in connector) {
      for (const [name, operation] of Object.entries(connector.operations)) {
        operation.fake = {
          response: {
            id: `${name}-fixture`,
            messages: [{ id: `${name}-message` }],
            drafts: [{ id: `${name}-draft` }],
          },
        };
      }
    }
  }
  const connectors = compileConnectors(JSON.stringify(catalog), { mode: 'fake' });
  if (!connectors.ok) throw new Error(JSON.stringify(connectors.errors));
  const manifest = await app.toManifest();
  const compiled = compileManifest(manifest, {
    catalog: new InMemoryCatalog(connectors.catalog),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const requests: CredentialRequest[] = [];
  const broker: CredentialBroker = {
    getCredential(request): Promise<DownstreamCredential> {
      requests.push(request);
      return Promise.resolve({ token: `${request.bindingId}-fixture-token` });
    },
  };
  return {
    artifact: compiled.artifact,
    deps: { connectors: new InMemoryConnectorRegistry(connectors.connectors), broker },
    requests,
  };
}

describe('multi-account Gmail flagship', () => {
  it('binds the same curated connector twice without provider ids, credentials, or real labels', async () => {
    const manifest = await app.toManifest();
    expect(manifest.connectors).toMatchObject({
      personal_gmail: {
        id: 'gmail',
        binding: {
          profile: 'user_oauth',
          connection: { id: 'personal_gmail', source: { kind: 'externalExchange' } },
        },
      },
      work_gmail: {
        id: 'gmail',
        binding: {
          profile: 'user_oauth',
          connection: { id: 'work_gmail', source: { kind: 'externalExchange' } },
        },
      },
    });
    const wire = JSON.stringify({ manifest, catalog: app.toConnectorCatalog() });
    expect(wire).not.toMatch(/access[_-]?token|client[_-]?secret/i);
  });

  it('emits enforceable canonical account arrays on every tool', async () => {
    const manifest = await app.toManifest();
    for (const tool of manifest.tools) {
      expect(tool.inputSchema.properties).toHaveProperty('accounts');
      expect(JSON.stringify(tool.inputSchema.properties.accounts)).toContain(PERSONAL_ACCOUNT);
      expect(JSON.stringify(tool.inputSchema.properties.accounts)).toContain(WORK_ACCOUNT);
    }
    const read = manifest.tools.find((tool) => tool.name === 'search_messages');
    const write = manifest.tools.find((tool) => tool.name === 'trash_message');
    const readAccountsSchema = JSON.stringify(read?.inputSchema.properties.accounts);
    const writeAccountsSchema = JSON.stringify(write?.inputSchema.properties.accounts);
    expect(readAccountsSchema).toContain(PERSONAL_ACCOUNT);
    expect(readAccountsSchema).toContain(WORK_ACCOUNT);
    expect(readAccountsSchema).toContain('"maxItems":2');
    expect(writeAccountsSchema).not.toContain('"maxItems":2');
  });

  it('allows subject-only or plain-body-only vacation replies but rejects an empty enabled reply', async () => {
    const manifest = await app.toManifest();
    const schema = manifest.tools.find((tool) => tool.name === 'update_vacation')?.inputSchema;
    if (schema === undefined) throw new Error('expected update_vacation schema');
    const base = { accounts: [PERSONAL_ACCOUNT], settings: { enable_auto_reply: true } };

    expect(
      validateJsonSchemaWithDefaults(schema, {
        ...base,
        settings: { ...base.settings, response_subject: 'Away' },
      }).issues,
    ).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(schema, {
        ...base,
        settings: { ...base.settings, response_body_plain_text: 'Back soon' },
      }).issues,
    ).toHaveLength(0);
    expect(validateJsonSchemaWithDefaults(schema, base).issues).not.toHaveLength(0);
  });

  it.each([
    [],
    ['unknown@example.com'],
    [PERSONAL_ACCOUNT, PERSONAL_ACCOUNT],
    [WORK_ACCOUNT, PERSONAL_ACCOUNT],
  ])('rejects invalid read accounts %j before connector dispatch', async (accounts) => {
    const setup = await compiledFixture();
    const schema = setup.artifact.tools.find(
      (candidate) => candidate.name === 'search_messages',
    )?.inputSchema;
    if (!schema) throw new Error('expected search schema');
    const result = validateJsonSchemaWithDefaults(schema, { accounts, query: '' });
    expect(result.issues).not.toHaveLength(0);
    expect(setup.requests).toHaveLength(0);
  });

  it('rejects multi-account mutations at the write schema boundary', async () => {
    const setup = await compiledFixture();
    const schema = setup.artifact.tools.find(
      (candidate) => candidate.name === 'trash_message',
    )?.inputSchema;
    if (!schema) throw new Error('expected trash schema');

    const result = validateJsonSchemaWithDefaults(schema, {
      accounts: [PERSONAL_ACCOUNT, WORK_ACCOUNT],
      message_id: 'fixture-message',
    });

    expect(result.issues).not.toHaveLength(0);
    expect(setup.requests).toHaveLength(0);
  });

  it('rejects a no-op label mutation before confirmation or credential lookup', async () => {
    const setup = await compiledFixture();

    await expect(
      prepareToolForConfirmation(
        setup.artifact,
        'modify_message_labels',
        { accounts: [PERSONAL_ACCOUNT], message_id: 'fixture-message' },
        setup.deps,
      ),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'arg_invalid' } });
    expect(setup.requests).toHaveLength(0);
  });

  it('routes personal, work, and combined reads to isolated bindings and preserves account labels', async () => {
    const personal = await compiledFixture();
    const personalResult = await executeTool(
      personal.artifact,
      'search_messages',
      { accounts: [PERSONAL_ACCOUNT], query: 'is:unread' },
      personal.deps,
    );
    expect(personal.requests.flatMap((request) => request.bindingId ?? [])).toEqual([
      'personal_gmail',
    ]);
    expect(personalResult).toMatchObject({
      ok: true,
      output: { results: [{ account: PERSONAL_ACCOUNT }] },
    });

    const work = await compiledFixture();
    const workResult = await executeTool(
      work.artifact,
      'search_messages',
      { accounts: [WORK_ACCOUNT], query: 'is:unread' },
      work.deps,
    );
    expect(work.requests.flatMap((request) => request.bindingId ?? [])).toEqual(['work_gmail']);
    expect(workResult).toMatchObject({
      ok: true,
      output: { results: [{ account: WORK_ACCOUNT }] },
    });

    const both = await compiledFixture();
    const bothResult = await executeTool(
      both.artifact,
      'search_messages',
      { accounts: [PERSONAL_ACCOUNT, WORK_ACCOUNT], query: 'is:unread' },
      both.deps,
    );
    expect(both.requests.flatMap((request) => request.bindingId ?? [])).toEqual([
      'personal_gmail',
      'work_gmail',
    ]);
    expect(bothResult).toMatchObject({
      ok: true,
      output: {
        results: [{ account: PERSONAL_ACCOUNT }, { account: WORK_ACCOUNT }],
      },
    });
  });

  it('prepares the exact selected write binding, dispatches only after confirmation, and rejects replay drift', async () => {
    const setup = await compiledFixture();
    const prepared = await prepareToolForConfirmation(
      setup.artifact,
      'trash_message',
      { accounts: [WORK_ACCOUNT], message_id: 'fixture-message' },
      setup.deps,
    );
    expect(isConfirmationRequired(prepared)).toBe(true);
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(setup.requests).toHaveLength(0);
    expect(prepared.review.action).toMatchObject({
      bindingId: 'work_gmail',
      connectionId: 'work_gmail',
      operation: 'trash_message',
    });

    await expect(
      executePreparedTool(setup.artifact, prepared.continuation, setup.deps),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(setup.requests.flatMap((request) => request.bindingId ?? [])).toEqual(['work_gmail']);

    const personalPrepared = structuredClone(prepared.continuation);
    if (personalPrepared.reviewedAction) {
      (personalPrepared.reviewedAction as { bindingId?: string }).bindingId = 'personal_gmail';
    }
    await expect(
      executePreparedTool(setup.artifact, personalPrepared, setup.deps),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('makes every mutation confirmable and keeps the personal-email skill concise and safe', async () => {
    const manifest = await app.toManifest();
    const catalog = app.toConnectorCatalog();
    const actionNames = new Set(
      catalog?.connectors.flatMap((connector) =>
        Object.entries(connector.operations)
          .filter(([, operation]) => operation.type === 'action')
          .map(([name]) => name),
      ),
    );
    for (const tool of manifest.tools.filter((candidate) => actionNames.has(candidate.name))) {
      expect(tool.annotations?.confirm, tool.name).toBe(true);
    }

    const skill = readFileSync(join(here, '../skills/personal-email-automation/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: personal-email-automation\ndescription:/);
    expect(skill.split('\n').length).toBeLessThan(140);
    expect(skill).toContain('accounts');
    expect(skill).toMatch(/draft/i);
    expect(skill).toMatch(/confirm/i);
    expect(skill).toMatch(/permanent delete/i);
    expect(skill).not.toMatch(/client[_-]?secret|access[_-]?token/i);
  });
});
