import { describe, expect, it } from 'vitest';
import { compileManifest, computeSignatureHash, InMemoryCatalog } from '../src/index.js';

const signature = {
  type: 'read' as const,
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: {}, additionalProperties: false },
};

const catalog = new InMemoryCatalog([
  {
    id: 'mail',
    version: '1.0.0',
    kind: 'catalog',
    credentialProfiles: { delegated: { kind: 'bearer' }, service: { kind: 'bearer' } },
    operationCredentials: {
      search: {
        profiles: ['delegated'],
        scopes: ['mail.read'],
        audience: 'https://mail.example.com',
      },
    },
    operations: { search: signature },
  },
] as never);

const googleCatalog = new InMemoryCatalog([
  {
    id: 'mail',
    version: '1.0.0',
    kind: 'catalog',
    credentialProfiles: {
      delegated: { kind: 'bearer' },
      service: { kind: 'bearer' },
    },
    operationCredentials: {
      search: {
        profiles: ['delegated'],
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        audience: 'https://gmail.googleapis.com',
      },
    },
    operations: { search: signature },
  },
] as never);

function manifest(profile = 'delegated') {
  return {
    manifestVersion: '2',
    server: { name: 'mail_reader', version: '1.0.0', title: 'Mail Reader' },
    connectors: {
      personal: {
        id: 'mail',
        version: '1.0.0',
        binding: {
          profile,
          connection: { id: 'personal_mail', source: { kind: 'externalExchange' } },
        },
      },
      work: {
        id: 'mail',
        version: '1.0.0',
        binding: {
          profile,
          connection: { id: 'work_mail', source: { kind: 'externalExchange' } },
        },
      },
    },
    tools: [
      {
        name: 'search_personal',
        description: 'Search personal mail.',
        inputSchema: signature.input,
        fulfilment: { use: 'personal.search', args: {} },
      },
      {
        name: 'search_work',
        description: 'Search work mail.',
        inputSchema: signature.input,
        fulfilment: { use: 'work.search', args: {} },
      },
    ],
  };
}

function withPersonalSource(source: Record<string, unknown>) {
  const raw = manifest();
  (
    raw.connectors.personal.binding.connection as {
      source: Record<string, unknown>;
    }
  ).source = source;
  return raw;
}

describe('Core v2 connector bindings', () => {
  it('resolves two aliases of one connector independently and emits an alias-keyed binding table', () => {
    const result = compileManifest(manifest(), { catalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.connectorBindings).toEqual({
      personal: {
        profile: 'delegated',
        connection: { id: 'personal_mail', source: { kind: 'externalExchange' } },
      },
      work: {
        profile: 'delegated',
        connection: { id: 'work_mail', source: { kind: 'externalExchange' } },
      },
    });
    const personalRef = result.artifact.tools[0]?.fulfilment;
    const workRef = result.artifact.tools[1]?.fulfilment;
    expect(personalRef?.kind).toBe('operation');
    expect(workRef?.kind).toBe('operation');
    if (personalRef?.kind !== 'operation' || workRef?.kind !== 'operation') return;
    expect(personalRef.operationRef).toMatchObject({
      credentialBinding: {
        bindingId: 'personal',
        connectionId: 'personal_mail',
        profile: 'delegated',
        presentation: { kind: 'bearer' },
        requiredScopes: ['mail.read'],
        requiredAudience: 'https://mail.example.com',
        connectionConfigRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(workRef.operationRef).toMatchObject({
      credentialBinding: {
        bindingId: 'work',
        connectionId: 'work_mail',
        profile: 'delegated',
        presentation: { kind: 'bearer' },
        requiredScopes: ['mail.read'],
        requiredAudience: 'https://mail.example.com',
      },
    });
    expect(
      personalRef.operationRef.resolved &&
        workRef.operationRef.resolved &&
        personalRef.operationRef.credentialBinding?.connectionConfigRevision,
    ).not.toBe(
      workRef.operationRef.resolved
        ? workRef.operationRef.credentialBinding?.connectionConfigRevision
        : undefined,
    );
    expect(JSON.stringify(result.artifact)).not.toContain('@');
    expect(JSON.stringify(result.artifact)).not.toContain('token');
  });

  it('derives connection revisions deterministically without emitting managed reference identifiers', () => {
    const source = {
      kind: 'managedSecret',
      secret: 'PRIVATE_MAIL_SECRET_REFERENCE',
      scopes: ['mail.read'],
      audience: 'https://mail.example.com',
    };
    const first = compileManifest(withPersonalSource(source), { catalog });
    const second = compileManifest(withPersonalSource({ ...source }), { catalog });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstRef = first.artifact.tools[0]?.fulfilment;
    const secondRef = second.artifact.tools[0]?.fulfilment;
    if (firstRef?.kind !== 'operation' || secondRef?.kind !== 'operation') return;
    expect(firstRef.operationRef).toMatchObject(secondRef.operationRef);
    expect(JSON.stringify(firstRef.operationRef)).not.toContain('PRIVATE_MAIL_SECRET_REFERENCE');
  });

  it('rejects a selected profile unsupported by the referenced operation', () => {
    const result = compileManifest(manifest('service'), { catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_credential_profile',
        path: 'connectors.personal.binding.profile',
        expected: 'delegated',
        got: 'service',
      }),
    );
  });

  it('rejects a credential-requiring operation without an alias binding', () => {
    const raw = manifest();
    delete (raw.connectors.personal as { binding?: unknown }).binding;
    const result = compileManifest(raw, { catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'connector_binding_required',
        path: 'connectors.personal',
        expected: 'delegated',
      }),
    );
  });

  it('keeps credential requirements outside operation signature hash inputs', () => {
    const withRequirements = (
      catalog as never as { get(id: string, version: string): unknown }
    ).get('mail', '1.0.0') as { operations: { search: typeof signature } };
    expect(computeSignatureHash('search', withRequirements.operations.search)).toBe(
      computeSignatureHash('search', signature),
    );
  });

  it('accepts client credentials whose declared scopes are a superset and audience matches', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'clientCredentials',
        tokenUrl: '${env.MAIL_TOKEN_URL}',
        clientId: '${env.MAIL_CLIENT_ID}',
        clientSecret: 'MAIL_CLIENT_SECRET',
        scopes: ['mail.read', 'mail.write'],
        audience: 'https://mail.example.com',
      }),
      { catalog },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a direct Google workload identity for a scoped Google bearer operation', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: { kind: 'direct' },
      }),
      { catalog: googleCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.connectorBindings?.personal).toMatchObject({
      connection: {
        source: {
          kind: 'googleWorkloadIdentity',
          provider: '${env.GOOGLE_WIF_PROVIDER}',
          access: { kind: 'direct' },
        },
      },
    });
    expect(result.artifact.config?.variables).toEqual(['GOOGLE_WIF_PROVIDER']);
  });

  it('accepts Google service-account impersonation using managed variables only', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: {
          kind: 'serviceAccountImpersonation',
          serviceAccount: '${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}',
        },
      }),
      { catalog: googleCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.config?.variables).toEqual([
      'GOOGLE_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_WIF_PROVIDER',
    ]);
  });

  it('rejects Google workload identity operations without scopes', () => {
    const noScopesCatalog = new InMemoryCatalog([
      {
        id: 'mail',
        version: '1.0.0',
        kind: 'catalog',
        credentialProfiles: { delegated: { kind: 'bearer' } },
        operationCredentials: {
          search: {
            profiles: ['delegated'],
            audience: 'https://gmail.googleapis.com',
          },
        },
        operations: { search: signature },
      },
    ] as never);
    const result = compileManifest(
      withPersonalSource({
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: { kind: 'direct' },
      }),
      { catalog: noScopesCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_scope_mismatch',
        path: 'connectors.personal.binding.connection.source.scopes',
      }),
    );
  });

  it('rejects Google workload identity for api-key presentation', () => {
    const apiKeyCatalog = new InMemoryCatalog([
      {
        id: 'mail',
        version: '1.0.0',
        kind: 'catalog',
        credentialProfiles: { delegated: { kind: 'apiKey', header: 'X-API-Key' } },
        operationCredentials: {
          search: {
            profiles: ['delegated'],
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            audience: 'https://gmail.googleapis.com',
          },
        },
        operations: { search: signature },
      },
    ] as never);
    const result = compileManifest(
      withPersonalSource({
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: { kind: 'direct' },
      }),
      { catalog: apiKeyCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_credential_profile',
        path: 'connectors.personal.binding.profile',
      }),
    );
  });

  it('rejects Google workload identity for non-Google scope and audience requirements', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: { kind: 'direct' },
      }),
      { catalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_scope_mismatch',
        path: 'connectors.personal.binding.connection.source.scopes',
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_audience_mismatch',
        path: 'connectors.personal.binding.connection.source.audience',
      }),
    );
  });

  it('rejects client credentials that do not declare a required scope', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'clientCredentials',
        tokenUrl: '${env.MAIL_TOKEN_URL}',
        clientId: '${env.MAIL_CLIENT_ID}',
        clientSecret: 'MAIL_CLIENT_SECRET',
        audience: 'https://mail.example.com',
      }),
      { catalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_scope_mismatch',
        path: 'connectors.personal.binding.connection.source.scopes',
        expected: 'mail.read',
      }),
    );
  });

  it('rejects client credentials with the wrong declared scope', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'clientCredentials',
        tokenUrl: '${env.MAIL_TOKEN_URL}',
        clientId: '${env.MAIL_CLIENT_ID}',
        clientSecret: 'MAIL_CLIENT_SECRET',
        scopes: ['mail.write'],
        audience: 'https://mail.example.com',
      }),
      { catalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_scope_mismatch',
        path: 'connectors.personal.binding.connection.source.scopes',
        expected: 'mail.read',
        got: 'mail.write',
      }),
    );
  });

  it('rejects client credentials whose audience does not match', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'clientCredentials',
        tokenUrl: '${env.MAIL_TOKEN_URL}',
        clientId: '${env.MAIL_CLIENT_ID}',
        clientSecret: 'MAIL_CLIENT_SECRET',
        scopes: ['mail.read'],
        audience: 'https://other.example.com',
      }),
      { catalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_audience_mismatch',
        path: 'connectors.personal.binding.connection.source.audience',
        expected: 'https://mail.example.com',
        got: 'https://other.example.com',
      }),
    );
  });

  it('accepts a managed secret with explicit matching capabilities', () => {
    const result = compileManifest(
      withPersonalSource({
        kind: 'managedSecret',
        secret: 'MAIL_ACCESS_TOKEN',
        scopes: ['mail.read', 'mail.write'],
        audience: 'https://mail.example.com',
      }),
      { catalog },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a managed secret that cannot prove required capabilities', () => {
    const result = compileManifest(
      withPersonalSource({ kind: 'managedSecret', secret: 'MAIL_ACCESS_TOKEN' }),
      { catalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'credential_scope_mismatch',
        path: 'connectors.personal.binding.connection.source.scopes',
        expected: 'mail.read',
      }),
    );
  });
});
