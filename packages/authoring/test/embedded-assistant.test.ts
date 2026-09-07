import { describe, expect, it } from 'vitest';
import type { PublicWebsiteInput } from '../src/assistant.js';
import {
  authenticatedWebsite,
  embeddedAssistant,
  noodleManaged,
  openAICompatible,
  publicWebsite,
  secret,
  server,
  tool,
  variable,
  z,
} from '../src/index.js';

const model = () =>
  openAICompatible({
    baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
    model: variable('ASSISTANT_MODEL'),
    apiKey: secret('ASSISTANT_MODEL_API_KEY'),
  });

describe('embedded assistant authoring', () => {
  it('preserves an explicit Responses transport in the authored model declaration', () => {
    expect(
      openAICompatible({
        transport: 'responses',
        baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
        model: variable('ASSISTANT_MODEL'),
        apiKey: secret('ASSISTANT_MODEL_API_KEY'),
      }),
    ).toEqual({
      kind: 'openai-compatible',
      transport: 'responses',
      baseUrl: '${env.ASSISTANT_MODEL_BASE_URL}',
      model: '${env.ASSISTANT_MODEL}',
      apiKey: 'ASSISTANT_MODEL_API_KEY',
    });
  });

  it('emits a provider-neutral Noodle-managed model declaration with no customer configuration', () => {
    expect(noodleManaged()).toEqual({ kind: 'noodle-managed' });
    expect(
      embeddedAssistant({
        model: noodleManaged(),
        access: publicWebsite({
          origins: ['https://www.acme.test'],
          capabilities: [],
        }),
      }).model,
    ).toEqual({ kind: 'noodle-managed' });
  });

  it('emits one server brand kit plus assistant-only UI configuration', async () => {
    const app = server(
      'acme_support',
      {
        title: 'Acme Support',
        version: '1.0.0',
        branding: {
          name: 'Acme',
          accent: '#5B4CF0',
          surface: '#FFFFFF',
          surfaceDark: '#15131A',
          logo: {
            uri: 'https://assets.acme.test/logo-dark.svg',
            darkUri: 'https://assets.acme.test/logo-light.svg',
            alt: 'Acme',
          },
          theme: { dark: { accent: '#A99FFF', text: '#FFFFFF' } },
        },
        assistant: embeddedAssistant({
          model: openAICompatible({
            baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
            model: variable('ASSISTANT_MODEL'),
            apiKey: secret('ASSISTANT_MODEL_API_KEY'),
          }),
          access: authenticatedWebsite({ origins: ['https://app.acme.test'] }),
          layout: {
            mode: 'floating',
            position: 'bottom-center',
            panelWidth: 420,
          },
          theme: 'invert',
          behavior: { showPoweredBy: false, showConfirmationDetails: false },
          labels: {
            welcomeHeading: 'How can Acme help?',
            launcherPlaceholder: 'Ask Acme anything',
            composerPlaceholder: 'Ask Acme…',
            thinking: 'Acme is thinking',
            sessionReady: 'Acme support is online',
            signInHeading: 'Continue with your Acme account',
            signInBody: 'Order history needs an account.',
            signInAction: 'Sign in to Acme',
            signUpAction: 'Create free account',
          },
          presentation: {
            panel: {
              surface: 'solid',
              radius: 20,
              border: 'strong',
              elevation: 'dramatic',
            },
            launcher: {
              style: 'bubble',
              icon: 'chat',
              size: 'lg',
              effect: 'pulse',
              status: 'session',
            },
            header: {
              mark: 'status',
              badge: { text: 'ONLINE', tone: 'success', indicator: true },
            },
            composer: { leadingIcon: 'brand-mark', sendIcon: 'paper-plane', shape: 'rounded' },
            messages: { userStyle: 'accent', assistantStyle: 'bubble' },
          },
        }),
      },
      [
        tool('health', {
          description: 'Read service health.',
          input: z.object({}),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.assistant).toEqual({
      model: {
        kind: 'openai-compatible',
        baseUrl: '${env.ASSISTANT_MODEL_BASE_URL}',
        model: '${env.ASSISTANT_MODEL}',
        apiKey: 'ASSISTANT_MODEL_API_KEY',
      },
      surfaces: [{ mode: 'authenticated', origins: ['https://app.acme.test'] }],
      allowedOrigins: ['https://app.acme.test'],
      layout: { mode: 'floating', position: 'bottom-center', panelWidth: 420 },
      theme: 'invert',
      behavior: { showPoweredBy: false, showConfirmationDetails: false },
      labels: {
        welcomeHeading: 'How can Acme help?',
        launcherPlaceholder: 'Ask Acme anything',
        composerPlaceholder: 'Ask Acme…',
        thinking: 'Acme is thinking',
        sessionReady: 'Acme support is online',
        signInHeading: 'Continue with your Acme account',
        signInBody: 'Order history needs an account.',
        signInAction: 'Sign in to Acme',
        signUpAction: 'Create free account',
      },
      presentation: {
        panel: {
          surface: 'solid',
          radius: 20,
          border: 'strong',
          elevation: 'dramatic',
        },
        launcher: {
          style: 'bubble',
          icon: 'chat',
          size: 'lg',
          effect: 'pulse',
          status: 'session',
        },
        header: {
          mark: 'status',
          badge: { text: 'ONLINE', tone: 'success', indicator: true },
        },
        composer: { leadingIcon: 'brand-mark', sendIcon: 'paper-plane', shape: 'rounded' },
        messages: { userStyle: 'accent', assistantStyle: 'bubble' },
      },
    });
    expect(manifest.server.branding).toMatchObject({
      name: 'Acme',
      logo: {
        uri: 'https://assets.acme.test/logo-dark.svg',
        darkUri: 'https://assets.acme.test/logo-light.svg',
      },
      theme: { dark: { accent: '#A99FFF', text: '#FFFFFF' } },
    });
  });

  it('rejects the wrong managed-config reference kinds', () => {
    expect(() =>
      openAICompatible({
        baseUrl: secret('URL'),
        model: variable('MODEL'),
        apiKey: secret('KEY'),
      }),
    ).toThrow('baseUrl');

    expect(() =>
      openAICompatible({
        baseUrl: variable('URL'),
        model: variable('MODEL'),
        apiKey: variable('KEY'),
      }),
    ).toThrow('apiKey');
  });

  it('lowers a public website projection to its access kind, origins, and capability allowlist', async () => {
    const askProduct = tool('ask_product', {
      description: 'Answer a product question.',
      input: z.object({ question: z.string() }),
      fulfil: () => ({ answer: 'yes' }),
    });
    const requestDemo = tool('request_demo', {
      description: 'Record a demo request.',
      input: z.object({ email: z.string() }),
      fulfil: () => ({ ok: true }),
    });
    const internalAudit = tool('internal_audit', {
      description: 'Internal only; never projected publicly.',
      input: z.object({}),
      fulfil: () => ({ ok: true }),
    });

    const app = server(
      'acme_site',
      {
        title: 'Acme Site',
        version: '1.0.0',
        assistant: embeddedAssistant({
          model: model(),
          access: publicWebsite({
            origins: ['https://www.acme.test'],
            capabilities: [askProduct, requestDemo],
            instructions: 'Guide visitors consultatively and offer the next useful step.',
          }),
        }),
      },
      [askProduct, requestDemo, internalAudit],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.assistant).toMatchObject({
      surfaces: [
        {
          mode: 'public',
          origins: ['https://www.acme.test'],
          capabilities: [
            { kind: 'tool', name: 'ask_product' },
            { kind: 'tool', name: 'request_demo' },
          ],
          instructions: 'Guide visitors consultatively and offer the next useful step.',
        },
      ],
      allowedOrigins: ['https://www.acme.test'],
    });
    // The server keeps every tool; only the projection is narrowed.
    expect(manifest.tools?.map((entry) => entry.name)).toContain('internal_audit');
    expect(manifest.server.assistant?.sessionClaims).toBeUndefined();
  });

  it('keeps sessionClaims on the authenticated branch and its manifest position unchanged', async () => {
    const health = tool('health', {
      description: 'Read service health.',
      input: z.object({}),
      fulfil: () => ({ ok: true }),
    });
    const app = server(
      'acme_app',
      {
        title: 'Acme App',
        version: '1.0.0',
        assistant: embeddedAssistant({
          model: model(),
          access: authenticatedWebsite({
            origins: ['https://app.acme.test'],
            sessionClaims: { plan: { exposeToModel: true } },
            instructions: 'Help signed-in customers complete their work.',
          }),
        }),
      },
      [health],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.assistant).toMatchObject({
      surfaces: [
        {
          mode: 'authenticated',
          origins: ['https://app.acme.test'],
          sessionClaims: { plan: { exposeToModel: true } },
          instructions: 'Help signed-in customers complete their work.',
        },
      ],
      allowedOrigins: ['https://app.acme.test'],
      // Mirrored to the top level so the service session exchange reads on unchanged.
      sessionClaims: { plan: { exposeToModel: true } },
    });
    // Authenticated assistants project the whole surface, so no allowlist is emitted.
    expect(manifest.server.assistant?.surfaces[0]?.capabilities).toBeUndefined();
  });

  it('preserves capability declaration order and drops duplicates', () => {
    const first = tool('first', {
      description: 'First.',
      input: z.object({}),
      fulfil: () => ({ ok: true }),
    });
    const second = tool('second', {
      description: 'Second.',
      input: z.object({}),
      fulfil: () => ({ ok: true }),
    });

    const assistant = embeddedAssistant({
      model: model(),
      access: publicWebsite({
        origins: ['https://www.acme.test'],
        capabilities: [second, first, second],
      }),
    });

    expect(assistant.surfaces[0]?.capabilities).toEqual([
      { kind: 'tool', name: 'second' },
      { kind: 'tool', name: 'first' },
    ]);
  });

  it('detaches the access origins from mutable author input', () => {
    const origins = ['https://www.acme.test'];
    const assistant = embeddedAssistant({
      model: model(),
      access: publicWebsite({ origins, capabilities: [] }),
    });

    origins[0] = 'https://evil.test';

    expect(assistant.allowedOrigins).toEqual(['https://www.acme.test']);
  });

  it('requires a capability allowlist on a public surface at the type level', () => {
    // Compiles only while `capabilities` is non-optional on the public surface constructor: a public
    // surface must be reviewable from one explicit list, never inferred from what happens to be declared.
    type CapabilitiesRequired = undefined extends PublicWebsiteInput['capabilities'] ? false : true;
    const capabilitiesRequired: CapabilitiesRequired = true;
    expect(capabilitiesRequired).toBe(true);
  });

  it('carries a public and an authenticated surface on one assistant', async () => {
    const askProduct = tool('ask_product', {
      description: 'Answer a product question.',
      input: z.object({ question: z.string() }),
      annotations: { readOnlyHint: true },
      fulfil: () => ({ answer: 'yes' }),
    });
    const listInvoices = tool('list_invoices', {
      description: 'List the signed-in customer invoices.',
      input: z.object({}),
      annotations: { readOnlyHint: true },
      fulfil: () => ({ invoices: [] }),
    });

    const app = server(
      'acme',
      {
        title: 'Acme',
        version: '1.0.0',
        assistant: embeddedAssistant({
          model: model(),
          access: [
            publicWebsite({
              origins: ['https://www.acme.test'],
              capabilities: [askProduct],
            }),
            authenticatedWebsite({
              origins: ['https://app.acme.test'],
              sessionClaims: { plan: { exposeToModel: true } },
            }),
          ],
        }),
      },
      [askProduct, listInvoices],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.assistant?.surfaces).toEqual([
      {
        mode: 'public',
        origins: ['https://www.acme.test'],
        capabilities: [{ kind: 'tool', name: 'ask_product' }],
      },
      {
        mode: 'authenticated',
        origins: ['https://app.acme.test'],
        sessionClaims: { plan: { exposeToModel: true } },
      },
    ]);
    // The union feeds the unchanged service origin check; claims mirror for the unchanged exchange.
    expect(manifest.server.assistant?.allowedOrigins).toEqual([
      'https://www.acme.test',
      'https://app.acme.test',
    ]);
    expect(manifest.server.assistant?.sessionClaims).toEqual({ plan: { exposeToModel: true } });
  });

  it('marks a sign-in capable public surface as mixed', () => {
    const askProduct = tool('ask_product', {
      description: 'Answer a product question.',
      input: z.object({}),
      annotations: { readOnlyHint: true },
      fulfil: () => ({ ok: true }),
    });

    const assistant = embeddedAssistant({
      model: model(),
      access: publicWebsite({
        origins: ['https://www.acme.test'],
        capabilities: [askProduct],
        signIn: true,
      }),
    });

    // `mixed` has a runtime now: an identity-dependent capability is offered rather than refused, and
    // the visitor signs in through the host application without leaving the conversation.
    expect(assistant.surfaces[0]?.mode).toBe('mixed');
    // Omitted or false is unchanged.
    expect(publicWebsite({ origins: ['https://a.test'], capabilities: [] }).mode).toBe('public');
    expect(
      publicWebsite({ origins: ['https://a.test'], capabilities: [], signIn: false }).mode,
    ).toBe('public');
  });

  it('rejects two surfaces of the same audience', () => {
    expect(() =>
      embeddedAssistant({
        model: model(),
        access: [
          publicWebsite({ origins: ['https://www.acme.test'], capabilities: [] }),
          publicWebsite({ origins: ['https://marketing.acme.test'], capabilities: [] }),
        ],
      }),
    ).toThrow(/one public/i);
  });

  it('rejects the same origin on two surfaces', () => {
    expect(() =>
      embeddedAssistant({
        model: model(),
        access: [
          publicWebsite({ origins: ['https://acme.test'], capabilities: [] }),
          authenticatedWebsite({ origins: ['https://acme.test'] }),
        ],
      }),
    ).toThrow(/https:\/\/acme\.test/);
  });

  it('rejects an empty surface list', () => {
    expect(() => embeddedAssistant({ model: model(), access: [] })).toThrow(/at least one/i);

    // Reported from production (#1061): a project on the pre-surfaces SDK, whose assistant declared
    // top-level `allowedOrigins`/`sessionClaims` and no `access`, failed its deploy with an internal
    // `TypeError: Cannot read properties of undefined (reading 'mode')`. Omitting `access` is an
    // ordinary authoring mistake and has to read like one, naming the constructor to reach for.
    const legacy = { model: model(), allowedOrigins: ['https://acme.test'] };
    expect(() => embeddedAssistant(legacy as never)).toThrow(/access/i);
    expect(() => embeddedAssistant(legacy as never)).toThrow(/publicWebsite|authenticatedWebsite/);
    expect(() => embeddedAssistant(legacy as never)).toThrow(/allowedOrigins/);
    expect(() => embeddedAssistant(legacy as never)).not.toThrow(TypeError);

    // The same for the authenticated half of the old shape, and for a surface that is not one of the
    // constructors at all -- both used to reach `.mode` on something that has none.
    expect(() =>
      embeddedAssistant({ model: model(), sessionClaims: { plan: {} } } as never),
    ).toThrow(/sessionClaims/);
    expect(() => embeddedAssistant({ model: model(), access: [undefined] } as never)).toThrow(
      /access/i,
    );
  });

  it('detaches nested presentation values and prompts from mutable author input', () => {
    const badge = { text: 'ONLINE', tone: 'success' as const, indicator: true };
    const suggestedPrompts = ['Original prompt'];
    const assistant = embeddedAssistant({
      model: openAICompatible({
        baseUrl: 'https://models.example/v1',
        model: 'example',
        apiKey: secret('ASSISTANT_MODEL_API_KEY'),
      }),
      access: authenticatedWebsite({ origins: ['https://app.example.com'] }),
      presentation: {
        header: { badge },
      },
      suggestedPrompts,
    });

    badge.text = 'MUTATED';
    suggestedPrompts[0] = 'Mutated prompt';

    expect(assistant.presentation).toMatchObject({
      header: { badge: { text: 'ONLINE', tone: 'success', indicator: true } },
    });
    expect(assistant.suggestedPrompts).toEqual(['Original prompt']);
  });
});
