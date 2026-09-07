import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import {
  type CredentialBroker,
  type CredentialRequest,
  executeTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  type PolicyContext,
  type PolicyGate,
} from '../src/index.js';

const signature = {
  type: 'read' as const,
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
};

function artifact() {
  const compiled = compileManifest(
    {
      manifestVersion: '2',
      server: { name: 'bound_mail', version: '1.0.0', title: 'Bound Mail' },
      connectors: Object.fromEntries(
        ['personal', 'work'].map((alias) => [
          alias,
          {
            id: 'mail',
            version: '1.0.0',
            binding: {
              profile: 'delegated',
              connection: { id: `${alias}_mail`, source: { kind: 'externalExchange' } },
            },
          },
        ]),
      ),
      tools: ['personal', 'work'].map((alias) => ({
        name: `search_${alias}`,
        description: `Search ${alias}.`,
        inputSchema: signature.input,
        fulfilment: { use: `${alias}.search`, args: {} },
      })),
    },
    {
      catalog: new InMemoryCatalog([
        {
          id: 'mail',
          version: '1.0.0',
          kind: 'catalog',
          credentialProfiles: { delegated: { kind: 'bearer' } },
          operationCredentials: {
            search: { profiles: ['delegated'], scopes: ['mail.read'], audience: 'mail-api' },
          },
          operations: { search: signature },
        },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.artifact;
}

describe('binding-aware runtime credential requests', () => {
  it('isolates two aliases and threads requirements plus hosted context to broker and policy', async () => {
    const requests: CredentialRequest[] = [];
    const contexts: PolicyContext[] = [];
    const broker: CredentialBroker = {
      async getCredential(request) {
        requests.push(request);
        return { token: request.bindingId === 'personal' ? 'personal-token' : 'work-token' };
      },
    };
    const policy: PolicyGate = {
      async before(context) {
        contexts.push(context);
        return { allow: true };
      },
      async after(_context, output) {
        return output;
      },
    };
    const seenTokens: string[] = [];
    const connector = new InMemoryConnector('mail', '1.0.0', {
      search: {
        signature,
        handler: (_args, credential) => {
          if ('token' in credential) seenTokens.push(credential.token);
          return { ok: true };
        },
      },
    });
    const deps = {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker,
      policy,
      tenantId: 'acme/mail/prod',
      deploymentId: 'dep_mail_1',
    };
    await executeTool(artifact(), 'search_personal', {}, deps);
    await executeTool(artifact(), 'search_work', {}, deps);
    expect(requests).toEqual([
      expect.objectContaining({
        bindingId: 'personal',
        connectionId: 'personal_mail',
        profile: 'delegated',
        presentation: { kind: 'bearer' },
        requiredScopes: ['mail.read'],
        requiredAudience: 'mail-api',
        tenantId: 'acme/mail/prod',
        deploymentId: 'dep_mail_1',
      }),
      expect.objectContaining({
        bindingId: 'work',
        connectionId: 'work_mail',
        profile: 'delegated',
        presentation: { kind: 'bearer' },
        requiredScopes: ['mail.read'],
        requiredAudience: 'mail-api',
        tenantId: 'acme/mail/prod',
        deploymentId: 'dep_mail_1',
      }),
    ]);
    expect(requests[0]?.connectionConfigRevision).not.toBe(requests[1]?.connectionConfigRevision);
    expect(contexts).toEqual(
      requests.map(({ caller: _caller, ...request }) => expect.objectContaining(request)),
    );
    expect(seenTokens).toEqual(['personal-token', 'work-token']);
  });

  it('keeps binding configuration and credential material out of safe failures', async () => {
    const secretReference = 'DO_NOT_LEAK_SECRET_REFERENCE';
    const broker: CredentialBroker = {
      async getCredential() {
        throw new Error(`${secretReference}: bearer-private-token`);
      },
    };
    const connector = new InMemoryConnector('mail', '1.0.0', {
      search: { signature, handler: vi.fn() },
    });
    const result = await executeTool(
      artifact(),
      'search_personal',
      {},
      {
        connectors: new InMemoryConnectorRegistry([connector]),
        broker,
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'credential_unavailable' } });
    expect(JSON.stringify(result)).not.toContain(secretReference);
    expect(JSON.stringify(result)).not.toContain('bearer-private-token');
  });
});
