import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import {
  connector,
  customerAuth,
  noodlePlatform,
  secret,
  server,
  tool,
  variable,
  when,
  z,
} from '../src/index.js';

const acme = connector('acme_orders')
  .version('1.2.0')
  .operation('get_order', {
    type: 'read',
    input: z.object({ id: z.string(), source: z.string().optional() }),
    output: z.object({
      id: z.string(),
      status: z.string(),
    }),
  })
  .operation('get_tracking', {
    type: 'read',
    input: z.object({ order_id: z.string() }),
    output: z.object({ url: z.string().optional() }),
  });

const billing = connector('billing')
  .version('2.0.0')
  .operation('get_invoice', {
    type: 'read',
    input: z.object({ id: z.string() }),
    output: z.object({ total: z.number().optional(), paid: z.boolean().optional() }),
  });

function catalogFor(...connectors: (typeof acme)[]) {
  return new InMemoryCatalog(
    connectors.map((c) => ({
      id: c.id,
      version: c.version,
      kind: 'custom',
      operations: c.operations,
    })),
  );
}

describe('TypeScript authoring SDK', () => {
  it('emits bounded literal latest-message constraints for model tool discovery', async () => {
    const app = server('contact_app', { title: 'Contact App', version: '1.0.0' }, [
      tool('open_contact_form', {
        description: 'Open the contact form after an explicit request.',
        annotations: { readOnlyHint: true },
        modelVisibility: {
          latestMessageIncludesAny: [' contact us ', 'talk to support'],
          oncePerSession: true,
          requiredWhenVisible: true,
        },
        input: z.object({}),
        fulfil: () => ({ ok: true }),
      }),
    ]);

    expect((await app.toManifest()).tools[0]?.annotations).toMatchObject({
      'x-noodleseed-model-latest-message-includes-any': ['contact us', 'talk to support'],
      'x-noodleseed-model-once-per-session': true,
      'x-noodleseed-model-required-when-visible': true,
    });
  });

  it.each([
    ['empty phrase list', []],
    ['blank phrase', ['   ']],
    ['duplicate phrase', ['Contact us', 'contact us']],
    ['too many phrases', Array.from({ length: 33 }, (_, index) => `phrase ${index}`)],
    ['oversize phrase', ['x'.repeat(129)]],
  ])('rejects an invalid model tool visibility constraint: %s', async (_label, phrases) => {
    const app = server('contact_app', { title: 'Contact App', version: '1.0.0' }, [
      tool('open_contact_form', {
        description: 'Open the contact form after an explicit request.',
        modelVisibility: { latestMessageIncludesAny: phrases },
        input: z.object({}),
        fulfil: () => ({ ok: true }),
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/modelVisibility\.latestMessageIncludesAny/u);
  });

  it('rejects the reserved model visibility annotation without the typed option', async () => {
    const app = server('contact_app', { title: 'Contact App', version: '1.0.0' }, [
      tool('open_contact_form', {
        description: 'Open the contact form after an explicit request.',
        annotations: {
          'x-noodleseed-model-latest-message-includes-any': ['contact us'],
        },
        input: z.object({}),
        fulfil: () => ({ ok: true }),
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(
      /Use modelVisibility\.latestMessageIncludesAny instead/u,
    );
  });

  it.each([
    'x-noodleseed-model-once-per-session',
    'x-noodleseed-model-required-when-visible',
  ])('rejects the reserved %s annotation without the typed option', async (annotation) => {
    const app = server('contact_app', { title: 'Contact App', version: '1.0.0' }, [
      tool('open_contact_form', {
        description: 'Open the contact form after an explicit request.',
        annotations: { [annotation]: true },
        input: z.object({}),
        fulfil: () => ({ ok: true }),
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/reserved model visibility annotation/u);
  });

  it('emits an explicit host confirmation fallback without changing tool annotations', async () => {
    const app = server(
      'host_confirmed_app',
      {
        title: 'Host Confirmed App',
        version: '1.0.0',
        interactions: { confirmationFallback: 'host' },
      },
      [
        tool('submit', {
          description: 'Submit a request.',
          input: z.object({}),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      manifestVersion: '2',
      server: { interactions: { confirmationFallback: 'host' } },
    });
  });

  it('emits Core v2 and an allowlisted federated OIDC customer boundary', async () => {
    const app = server(
      'federated_app',
      {
        title: 'Federated App',
        version: '1.0.0',
        auth: customerAuth.federatedOidc({
          issuers: [
            { issuer: 'https://accounts.example.com', audience: 'api://federated-app' },
            { issuer: 'https://login.partner.example', audience: 'api://partner-app' },
          ],
        }),
      },
      [
        tool('whoami', {
          description: 'Show the customer',
          input: z.object({}),
          fulfil: ({ user }) => ({ subject: user.subject }),
        }),
      ],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      manifestVersion: '2',
      server: {
        auth: {
          kind: 'federatedOidc',
          issuers: [
            { issuer: 'https://accounts.example.com', audience: 'api://federated-app' },
            { issuer: 'https://login.partner.example', audience: 'api://partner-app' },
          ],
        },
      },
    });
  });

  it('designates one normal zero-input tool as the portable context provider', async () => {
    const app = server('contextual_app', { title: 'Contextual App', version: '1.0.0' }, [
      tool('current_workspace', {
        description: 'Return the verified current workspace.',
        contextProvider: true,
        input: z.object({}),
        output: z.object({ workspaceId: z.string() }),
        fulfil: () => ({ workspaceId: 'workspace-1' }),
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.tools[0]).toMatchObject({ name: 'current_workspace', contextProvider: true });
    const compiled = compileManifest(manifest);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.artifact.tools[0]?.contextProvider).toBe(true);
  });
  it('emits direct OIDC customer auth and user expressions', async () => {
    const app = server(
      'customer_portal',
      {
        title: 'Customer Portal',
        version: '1.0.0',
        auth: customerAuth.oidc({
          issuer: 'https://id.example.com',
          audience: 'api://customer-portal',
          claims: { id: 'sub', email: 'email', tenant: 'org_id', roles: 'roles' },
        }),
      },
      [
        tool('whoami', {
          description: 'Show the verified customer',
          input: z.object({}),
          fulfil: ({ user }) => ({
            id: user.subject,
            email: user.email,
            tenant: user.tenant,
          }),
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.auth).toEqual({
      kind: 'oidc',
      issuer: 'https://id.example.com',
      audience: 'api://customer-portal',
      claims: { id: 'sub', email: 'email', tenant: 'org_id', roles: 'roles' },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      id: '${user.subject}',
      email: '${user.email}',
      tenant: '${user.tenant}',
    });
  });

  it('emits Firebase customer auth as a provider-specific bridge', async () => {
    const app = server(
      'firebase_customer_portal',
      {
        title: 'Firebase Customer Portal',
        version: '1.0.0',
        auth: customerAuth.firebase({
          projectId: 'noodleseed-prod',
          apiKey: 'firebase-public-web-api-key',
          authDomain: 'noodleseed-prod.firebaseapp.com',
          appId: 'firebase-web-app-id',
          tenantId: 'tenant-a',
          user: { id: 'sub', email: 'email', tenant: 'firebase.tenant', roles: 'claims.roles' },
        }),
      },
      [
        tool('whoami', {
          description: 'Show the verified Firebase customer',
          input: z.object({}),
          fulfil: ({ user }) => ({
            id: user.subject,
            email: user.email,
            tenant: user.tenant,
          }),
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.auth).toEqual({
      kind: 'bridge',
      provider: 'firebase',
      projectId: 'noodleseed-prod',
      apiKey: 'firebase-public-web-api-key',
      authDomain: 'noodleseed-prod.firebaseapp.com',
      appId: 'firebase-web-app-id',
      tenantId: 'tenant-a',
      user: { id: 'sub', email: 'email', tenant: 'firebase.tenant', roles: 'claims.roles' },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      id: '${user.subject}',
      email: '${user.email}',
      tenant: '${user.tenant}',
    });
  });

  it('emits Firebase public client configuration as managed-variable references', async () => {
    const app = server('firebase_customer_portal', {
      title: 'Firebase Customer Portal',
      version: '1.0.0',
      auth: customerAuth.firebase({
        projectId: variable('FIREBASE_PROJECT_ID'),
        apiKey: variable('FIREBASE_WEB_API_KEY'),
        authDomain: variable('FIREBASE_AUTH_DOMAIN'),
        appId: variable('FIREBASE_APP_ID'),
        tenantId: variable('FIREBASE_TENANT_ID'),
      }),
    });

    expect((await app.toManifest()).server.auth).toEqual({
      kind: 'bridge',
      provider: 'firebase',
      projectId: '${env.FIREBASE_PROJECT_ID}',
      apiKey: '${env.FIREBASE_WEB_API_KEY}',
      authDomain: '${env.FIREBASE_AUTH_DOMAIN}',
      appId: '${env.FIREBASE_APP_ID}',
      tenantId: '${env.FIREBASE_TENANT_ID}',
    });
  });

  it('rejects secret references for browser-visible Firebase client configuration', () => {
    expect(() =>
      customerAuth.firebase({
        projectId: variable('FIREBASE_PROJECT_ID'),
        apiKey: secret('FIREBASE_WEB_API_KEY'),
      }),
    ).toThrow('server.auth.apiKey: secret("FIREBASE_WEB_API_KEY") can only be used');
  });

  it('emits Microsoft customer auth with a managed client-secret reference', async () => {
    const app = server(
      'microsoft_customer_portal',
      {
        title: 'Microsoft Customer Portal',
        version: '1.0.0',
        auth: customerAuth.microsoft({
          tenantId: 'contoso-tenant',
          clientId: 'microsoft-client-id',
          clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
          tokenUrl: 'https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token',
          scopes: ['https://graph.microsoft.com/Sites.Selected'],
          authMethod: 'client_secret_post',
          user: { id: 'sub', email: 'preferred_username' },
        }),
      },
      [
        tool('whoami', {
          description: 'Show the verified Microsoft customer',
          input: z.object({}),
          fulfil: ({ user }) => ({
            id: user.subject,
            email: user.email,
          }),
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.auth).toEqual({
      kind: 'bridge',
      provider: 'microsoft',
      tenantId: 'contoso-tenant',
      clientId: 'microsoft-client-id',
      clientSecret: 'MICROSOFT_CLIENT_SECRET',
      tokenUrl: 'https://login.microsoftonline.com/contoso-tenant/oauth2/v2.0/token',
      scopes: ['https://graph.microsoft.com/Sites.Selected'],
      authMethod: 'client_secret_post',
      user: { id: 'sub', email: 'preferred_username' },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      id: '${user.subject}',
      email: '${user.email}',
    });
    expect(compileManifest(manifest).ok).toBe(true);
  });

  it('emits Microsoft customer auth with managed tenant and client variables', async () => {
    const app = server(
      'microsoft_customer_portal',
      {
        title: 'Microsoft Customer Portal',
        version: '1.0.0',
        auth: customerAuth.microsoft({
          tenantId: variable('MICROSOFT_TENANT_ID'),
          clientId: variable('MICROSOFT_CLIENT_ID'),
          clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
          scopes: ['https://graph.microsoft.com/Sites.Selected'],
        }),
      },
      [
        tool('whoami', {
          description: 'Show the verified Microsoft customer',
          input: z.object({}),
          fulfil: ({ user }) => ({
            id: user.subject,
            email: user.email,
          }),
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.auth).toMatchObject({
      kind: 'bridge',
      provider: 'microsoft',
      tenantId: '${env.MICROSOFT_TENANT_ID}',
      clientId: '${env.MICROSOFT_CLIENT_ID}',
      clientSecret: 'MICROSOFT_CLIENT_SECRET',
    });
    expect(compileManifest(manifest).ok).toBe(true);
  });

  it('emits tenant auth for customer-access deployments', async () => {
    const app = server(
      'customer_portal',
      {
        title: 'Customer Portal',
        version: '1.0.0',
        auth: {
          issuer: 'https://idp.example.com',
          audience: 'customer-portal',
        },
      },
      [
        tool('ping', {
          description: 'Return pong.',
          input: z.object({}),
          fulfil({ user }) {
            return { subject: user.subject, email: user.email.optional() };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.server.auth).toEqual({
      issuer: 'https://idp.example.com',
      audience: 'customer-portal',
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      subject: '${user.subject}',
      email: '${user.email}',
    });
  });

  it('records a functional TypeScript server definition as a manifest', async () => {
    const app = server('acme_support', { title: 'Acme Support', version: '1.0.0', use: { acme } }, [
      tool('track_order', {
        description: 'Find shipment tracking for an order.',
        input: z.object({ orderId: z.string() }),
        async fulfil({ input, connectors }) {
          const order = connectors.acme.getOrder({ id: input.orderId });
          const tracking = when(order.status.equals('shipped'), () =>
            connectors.acme.getTracking({ order_id: order.id }),
          );

          return {
            orderId: order.id,
            status: order.status,
            trackingUrl: tracking.url.optional(),
          };
        },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.connectors).toEqual({ acme: { id: 'acme_orders', version: '1.2.0' } });
    expect(manifest.tools[0]?.fulfilment).toEqual({
      steps: [
        { id: 'get_order', use: 'acme.get_order', args: { id: '${input.orderId}' } },
        {
          id: 'get_tracking',
          if: '${steps.get_order.status === "shipped"}',
          use: 'acme.get_tracking',
          args: { order_id: '${steps.get_order.id}' },
        },
      ],
      output: {
        orderId: '${steps.get_order.id}',
        status: '${steps.get_order.status}',
        trackingUrl: '${steps.get_tracking.url}',
      },
    });

    const compiled = compileManifest(manifest, {
      catalog: catalogFor(acme),
    });
    expect(compiled.ok).toBe(true);
  });

  it('emits typed state handles and records state connector helper tools', async () => {
    const app = server(
      'stateful_app',
      {
        title: 'Stateful App',
        version: '1.0.0',
        state: {
          handles: {
            draft: {
              kind: 'draft',
              version: 'v1',
              scope: 'caller',
              ttlSeconds: 3_600,
              claimOnAuthentication: true,
              schema: z.object({ title: z.string() }),
            },
          },
        },
        use: { state: noodlePlatform.state.v1 },
      },
      [
        tool('load_draft', {
          description: 'Load draft state.',
          input: z.object({}),
          output: z.object({ value: z.object({}).optional(), revision: z.number() }),
          visibility: ['app'],
          fulfil({ connectors }) {
            const state = connectors.state.readState({ handle: 'draft' });
            return { value: state.value, revision: state.revision };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.state).toMatchObject({
      handles: {
        draft: {
          kind: 'draft',
          version: 'v1',
          scope: 'caller',
          ttlSeconds: 3600,
          claimOnAuthentication: true,
          schema: { type: 'object' },
        },
      },
    });
    expect(manifest.connectors).toEqual({ state: { id: 'noodle_state', version: '1.0.0' } });
    expect(manifest.tools[0]?.fulfilment).toMatchObject({
      steps: [{ id: 'read_state', use: 'state.read_state', args: { handle: 'draft' } }],
      output: { value: '${steps.read_state.value}', revision: '${steps.read_state.revision}' },
    });
  });

  it("projects state-handle schemas io:'input' so defaulted/optional fields are not required on write", async () => {
    const app = server(
      'stateful_app',
      {
        title: 'Stateful App',
        version: '1.0.0',
        state: {
          handles: {
            draft: {
              kind: 'draft',
              version: 'v1',
              schema: z.object({
                title: z.string(),
                theme: z.string().default('light'),
                note: z.string().optional(),
              }),
            },
          },
        },
        use: { state: noodlePlatform.state.v1 },
      },
      [
        tool('load_draft', {
          description: 'Load draft state.',
          input: z.object({}),
          output: z.object({ revision: z.number() }),
          visibility: ['app'],
          fulfil({ connectors }) {
            const state = connectors.state.readState({ handle: 'draft' });
            return { revision: state.revision };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();
    const schema = manifest.state?.handles.draft?.schema as Record<string, unknown>;
    // A write relying on `.default()`/`.optional()` must validate: only `title` stays required.
    expect(schema.required).toEqual(['title']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('records multiple tools, multiple connector aliases, raw schemas, output schemas, and literal args', async () => {
    const app = server(
      'multi_support',
      { title: 'Multi Support', version: '1.0.0', use: { acme, billing } },
      [
        tool('get_order', {
          description: 'Get an order.',
          input: {
            type: 'object',
            properties: { order_id: { type: 'string' } },
            required: ['order_id'],
            additionalProperties: false,
          },
          output: z.object({
            id: z.string(),
            source: z.string(),
          }),
          fulfil({ input, connectors }) {
            const order = connectors.acme.getOrder({ id: input.order_id, source: 'typed-sdk' });
            return { id: order.id, source: 'typed-sdk' };
          },
        }),
        tool('get_invoice', {
          description: 'Get an invoice.',
          input: z.object({ invoiceId: z.string() }),
          output: z.object({ total: z.number().optional(), paid: z.boolean().optional() }),
          fulfil({ input, connectors }) {
            const invoice = connectors.billing.getInvoice({ id: input.invoiceId });
            return { total: invoice.total, paid: invoice.paid };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.connectors).toEqual({
      acme: { id: 'acme_orders', version: '1.2.0' },
      billing: { id: 'billing', version: '2.0.0' },
    });
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, source: { type: 'string' } },
    });
    expect(manifest.tools[0]?.fulfilment).toMatchObject({
      steps: [
        {
          id: 'get_order',
          use: 'acme.get_order',
          args: { id: '${input.order_id}', source: 'typed-sdk' },
        },
      ],
      output: { id: '${steps.get_order.id}', source: 'typed-sdk' },
    });
    expect(manifest.tools[1]?.fulfilment).toMatchObject({
      steps: [
        { id: 'get_invoice', use: 'billing.get_invoice', args: { id: '${input.invoiceId}' } },
      ],
      output: { total: '${steps.get_invoice.total}', paid: '${steps.get_invoice.paid}' },
    });

    const compiled = compileManifest(manifest, { catalog: catalogFor(acme, billing) });
    expect(compiled.ok).toBe(true);
  });

  it('assigns stable unique step ids for repeated operation calls in one tool', async () => {
    const app = server(
      'repeat_support',
      { title: 'Repeat Support', version: '1.0.0', use: { acme } },
      [
        tool('compare_orders', {
          description: 'Compare two orders.',
          input: z.object({ left: z.string(), right: z.string() }),
          fulfil({ input, connectors }) {
            const left = connectors.acme.getOrder({ id: input.left });
            const right = connectors.acme.getOrder({ id: input.right });
            return { left: left.status, right: right.status };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.tools[0]?.fulfilment).toMatchObject({
      steps: [
        { id: 'get_order', use: 'acme.get_order', args: { id: '${input.left}' } },
        { id: 'get_order_2', use: 'acme.get_order', args: { id: '${input.right}' } },
      ],
      output: {
        left: '${steps.get_order.status}',
        right: '${steps.get_order_2.status}',
      },
    });

    const compiled = compileManifest(manifest, { catalog: catalogFor(acme) });
    expect(compiled.ok).toBe(true);
  });

  it('restores outer when conditions after nested conditional recordings', async () => {
    const app = server(
      'condition_support',
      { title: 'Condition Support', version: '1.0.0', use: { acme } },
      [
        tool('conditional_tracking', {
          description: 'Fetch tracking conditionally.',
          input: z.object({ id: z.string(), backup_id: z.string() }),
          fulfil({ input, connectors }) {
            const order = connectors.acme.getOrder({ id: input.id });
            when(order.status.equals('shipped'), () => {
              connectors.acme.getTracking({ order_id: order.id });
            });
            const backup = connectors.acme.getOrder({ id: input.backup_id });
            return { backupStatus: backup.status };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.tools[0]?.fulfilment).toMatchObject({
      steps: [
        { id: 'get_order', use: 'acme.get_order' },
        {
          id: 'get_tracking',
          if: '${steps.get_order.status === "shipped"}',
          use: 'acme.get_tracking',
        },
        { id: 'get_order_2', use: 'acme.get_order' },
      ],
      output: { backupStatus: '${steps.get_order_2.status}' },
    });
  });

  it('omits the connectors block and compiles a pure (connector-free) tool', async () => {
    const app = server('empty_support', { title: 'Empty Support', version: '1.0.0' }, [
      tool('echo', {
        description: 'Returns its input with no connector calls.',
        input: z.object({ id: z.string() }),
        fulfil({ input }) {
          return { id: input.id };
        },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.connectors).toBeUndefined();
    // A connector-free fulfilment is a steps-less flow (pure output) — valid since the wire-migration slice.
    expect(manifest.tools[0]?.fulfilment).toMatchObject({
      steps: [],
      output: { id: '${input.id}' },
    });

    const compiled = compileManifest(manifest);
    expect(compiled.ok).toBe(true);
  });

  it('rejects non-serializable fulfilment outputs', async () => {
    const app = server('bad_server', { title: 'Bad', version: '1.0.0', use: { acme } }, [
      tool('bad_tool', {
        description: 'Bad tool',
        input: z.object({ id: z.string() }),
        fulfil({ input, connectors }) {
          connectors.acme.getOrder({ id: input.id });
          return { bad: () => 'nope' };
        },
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/cannot serialize function/);
  });

  it('rejects non-object fulfilment outputs', async () => {
    const app = server('bad_server', { title: 'Bad', version: '1.0.0', use: { acme } }, [
      tool('bad_tool', {
        description: 'Bad tool',
        input: z.object({ id: z.string() }),
        fulfil({ input, connectors }) {
          connectors.acme.getOrder({ id: input.id });
          return connectors.acme.getOrder({ id: input.id }).id;
        },
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/plain object mapping/);
  });

  it('carries connector-result refs inside nested mapping values', async () => {
    // Nested objects/arrays used to be rejected at recording time ("in this phase"); they are now
    // first-class so list/detail shapes (carousels, orders) keep their natural structure.
    const app = server('nested_server', { title: 'Nested', version: '1.0.0', use: { acme } }, [
      tool('nested_tool', {
        description: 'Nested tool',
        input: z.object({ id: z.string() }),
        fulfil({ input, connectors }) {
          const order = connectors.acme.getOrder({ id: input.id });
          return { order: { id: order.id } };
        },
      }),
    ]);

    const manifest = await app.toManifest();
    expect(JSON.stringify(manifest)).toMatch(/"order":\{"id":"\$\{[^}]+\}"\}/);
    expect(compileManifest(manifest).ok).toBe(true);
  });

  it('rejects unknown connector operations with a targeted error', async () => {
    const app = server(
      'unknown_op_server',
      { title: 'Unknown Op', version: '1.0.0', use: { acme } },
      [
        tool('unknown_op_tool', {
          description: 'Unknown operation tool',
          input: z.object({ id: z.string() }),
          fulfil({ input, connectors }) {
            const result = connectors.acme.missingOperation({ id: input.id });
            return { id: result.id };
          },
        }),
      ],
    );

    await expect(app.toManifest()).rejects.toThrow(
      /unknown operation "missingOperation" on connector alias "acme"/,
    );
  });

  it('rejects when outside a recorded fulfilment', () => {
    expect(() =>
      when(
        {
          toExpression: () => '${input.enabled}',
        },
        () => 'nope',
      ),
    ).toThrow(/only be used while recording/);
  });

  it('rejects non-scalar condition literals', async () => {
    const app = server(
      'bad_condition_server',
      { title: 'Bad Condition', version: '1.0.0', use: { acme } },
      [
        tool('bad_condition_tool', {
          description: 'Bad condition tool',
          input: z.object({ id: z.string() }),
          fulfil({ input, connectors }) {
            const order = connectors.acme.getOrder({ id: input.id });
            when(order.status.equals({ boxed: true }), () =>
              connectors.acme.getTracking({ order_id: order.id }),
            );
            return { id: order.id };
          },
        }),
      ],
    );

    await expect(app.toManifest()).rejects.toThrow(/scalar literals only/);
  });

  it('records explicit array indexes with bracket syntax for conditional routing', async () => {
    const app = server(
      'indexed_condition_server',
      { title: 'Indexed Condition', version: '1.0.0', use: { acme } },
      [
        tool('route_account', {
          description: 'Route by the first selected account.',
          input: z.object({ accounts: z.tuple([z.literal('personal@example.com')]) }),
          fulfil({ input, connectors }) {
            const order = when(input.accounts.at(0).equals('personal@example.com'), () =>
              connectors.acme.getOrder({ id: 'personal' }),
            );
            return { id: order.id.optional() };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.steps?.[0]?.if).toBe(
      '${input.accounts[0] === "personal@example.com"}',
    );
  });

  it('serializes nested explicit array indexes in fulfilment output', async () => {
    const app = server('nested_index_server', { title: 'Nested index', version: '1.0.0' }, [
      tool('pick_cell', {
        description: 'Pick one nested array cell.',
        input: z.object({ matrix: z.array(z.array(z.string())) }),
        fulfil: ({ input }) => ({ value: input.matrix.at(0).at(1) }),
      }),
    ]);

    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.output).toEqual({ value: '${input.matrix[0][1]}' });
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects unsafe symbolic array index %s', async (index) => {
    const app = server('bad_index_server', { title: 'Bad index', version: '1.0.0' }, [
      tool('pick_cell', {
        description: 'Reject an unsafe symbolic index.',
        input: z.object({ values: z.array(z.string()) }),
        fulfil: ({ input }) => ({ value: input.values.at(index) }),
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/non-negative safe integers/);
  });
});

describe('symbolic ref misuse teaching error', () => {
  it('throws a teaching error (not "is not a function") when a method is called on a symbolic ref', async () => {
    const app = server('ref_method_server', { title: 'Ref Method', version: '1.0.0' }, [
      tool('trim_name', {
        description: 'Attempts to call a method on a symbolic ref.',
        input: z.object({ name: z.string() }),
        fulfil: ({ input }) => ({
          // Calling `.trim()` on a symbolic ref is a mistake: its value is unknown while recording.
          name: (input.name as unknown as { trim(): string }).trim(),
        }),
      }),
    ]);
    await expect(app.toManifest()).rejects.toThrow(/template literal|when\(/);
    await expect(app.toManifest()).rejects.not.toThrow(/is not a function/);
  });

  it('still supports template-literal composition, .equals(), and .optional() on refs', async () => {
    const app = server('ref_ok_server', { title: 'Ref OK', version: '1.0.0', use: { acme } }, [
      tool('summarize', {
        description: 'Uses refs the supported ways.',
        input: z.object({ id: z.string() }),
        fulfil: ({ input, connectors }) => {
          const order = connectors.acme.getOrder({ id: input.id });
          const tracking = when(order.status.equals('shipped'), () =>
            connectors.acme.getTracking({ order_id: order.id }),
          );
          return {
            // Template-literal coercion still records the `${...}` expression.
            label: `Order ${input.id}`,
            trackingUrl: tracking.url.optional(),
          };
        },
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      label: 'Order ${input.id}',
      trackingUrl: '${steps.get_tracking.url}',
    });
    expect(manifest.tools[0]?.fulfilment.steps[1]).toMatchObject({
      if: '${steps.get_order.status === "shipped"}',
    });
  });
});

describe('tool input schema io projection (.default() is not required)', () => {
  it('emits an input schema where .default()/.optional() drop from required but the default persists', async () => {
    const app = server('io_input_server', { title: 'IO Input', version: '1.0.0' }, [
      tool('greet', {
        description: 'Greet a person by name.',
        input: z.object({
          name: z.string().default('x'),
          o: z.string().optional(),
          req: z.string(),
        }),
        fulfil: ({ input }) => ({ echo: input.req }),
      }),
    ]);
    const manifest = await app.toManifest();
    const inputSchema = manifest.tools[0]?.inputSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties: { name: { default?: string } };
    };
    // .default()/.optional() are honoured at call time, so only the genuinely-required field remains.
    expect(inputSchema.required).toEqual(['req']);
    // io:'input' drops Zod's forced closed-object shape; we re-assert it so unknown props still reject.
    expect(inputSchema.additionalProperties).toBe(false);
    // The default value is still advertised (it was contradicted by the old required: ['name'] shape).
    expect(inputSchema.properties.name.default).toBe('x');
  });
});
