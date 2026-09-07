import {
  annotations,
  authenticatedWebsite,
  connector,
  embeddedAssistant,
  noodleManaged,
  publicWebsite,
  server,
  tool,
  z,
} from '@noodleseed/one';

const draft = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  audience: z.string().trim().min(1).max(240).optional(),
  goal: z.string().trim().min(1).max(240).optional(),
});

const snapshot = z.object({
  value: draft,
  revision: z.number().int(),
  status: z.string(),
});

const state = connector('noodle_state')
  .version('1.0.0')
  .operation('read_state', {
    type: 'read',
    input: z.object({ handle: z.string() }),
    output: snapshot,
  })
  .operation('patch_state', {
    type: 'action',
    input: z.object({
      handle: z.string(),
      expectedRevision: z.number().int().min(0),
      value: draft,
    }),
    output: snapshot,
  });

const openDraft = tool('open_draft', {
  title: 'Review your brief',
  description:
    'Preview a proposed brief and read the saved brief with its revision. Pass the proposed title, audience, and goal in proposal to prefill the editable preview without saving it. Omit proposal to reload the saved record after a conflict.',
  input: z.object({ proposal: draft.default({}) }),
  output: snapshot.extend({ proposal: draft }),
  fulfil: ({ input, connectors }) => {
    const saved = connectors.state.readState({ handle: 'draft' });
    return {
      value: saved.value,
      revision: saved.revision,
      status: saved.status,
      proposal: input.proposal,
    };
  },
  viewTitle: 'Your project brief',
  invoking: 'Loading your saved brief…',
  invoked: 'Your brief is ready to review',
  view: { component: 'draft-card', entry: './views/draft-card.tsx' },
  annotations: annotations.readOnly(),
  viewDescription: 'Review and edit a saved brief before deciding whether to create an account.',
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
});

const saveDraft = tool('save_draft', {
  title: 'Save your brief',
  description:
    'Save this reviewed brief for up to 24 hours. This does not create an account or a project.',
  input: draft.required().extend({
    expectedRevision: z.number().int().min(0).meta({ title: 'Saved version' }),
  }),
  output: snapshot,
  annotations: annotations.localAction({ destructive: false, confirm: true }),
  fulfil: ({ input, connectors }) => {
    const saved = connectors.state.patchState({
      handle: 'draft',
      expectedRevision: input.expectedRevision,
      value: { title: input.title, audience: input.audience, goal: input.goal },
    });
    return { value: saved.value, revision: saved.revision, status: saved.status };
  },
});

const continueDraft = tool('continue_draft', {
  title: 'Continue with an account',
  description:
    'Read the brief in the signed-in account. Call only when the visitor chooses to continue with an account, after showing useful value. Sign-in carries the saved draft forward; it does not submit, publish, or create a project.',
  input: z.object({}),
  output: snapshot.extend({ accountId: z.string() }),
  annotations: annotations.readOnly(),
  fulfil: ({ connectors, user }) => {
    const saved = connectors.state.readState({ handle: 'draft' });
    return {
      value: saved.value,
      revision: saved.revision,
      status: saved.status,
      accountId: user.id,
    };
  },
});

export default server(
  'stateful_draft',
  {
    title: 'Your first useful brief',
    version: '1.0.0',
    instructions:
      'Help someone turn their goal into a concise project brief: a title, audience, and desired outcome. Base the brief on information they supply. Propose a sensible editable title; never require a naming question. If the audience and outcome are already clear, immediately show the complete proposed brief. Otherwise ask one short question for missing information and skip anything already answered. Show the useful proposed brief in chat before offering to save it. Do not request an email, password, document, or external research. Read open_draft before save_draft. Saving requires review and confirmation; an unconfirmed save is not persisted. Never claim an account or project was created. After saving, offer continue_draft only as an optional next step; never require signup to see the brief. This is a synthetic onboarding example, not an integration with a specific SaaS product.',
    branding: {
      name: 'First Brief',
      accent: '#2563EB',
      surface: '#F8FAFC',
      surfaceDark: '#111827',
      radius: 'md',
      density: 'comfortable',
      typography: 'system',
      colorScheme: 'auto',
    },
    use: { state },
    state: {
      handles: {
        draft: {
          kind: 'draft',
          version: 'v2',
          scope: 'caller',
          ttlSeconds: 86400,
          claimOnAuthentication: true,
          schema: draft,
        },
      },
    },
    assistant: embeddedAssistant({
      model: noodleManaged(),
      privacyUrl: 'https://noodleseed.com/privacy',
      access: [
        publicWebsite({
          origins: ['http://localhost:3001'],
          capabilities: [openDraft, saveDraft, continueDraft],
          signIn: true,
        }),
        authenticatedWebsite({
          origins: ['http://localhost:3002'],
          capabilities: [openDraft, saveDraft, continueDraft],
        }),
      ],
      labels: {
        welcomeHeading: 'What would you like to achieve?',
        composerPlaceholder: 'Describe your goal…',
        signInHeading: 'Take your brief with you',
        signInBody: 'Continue with an account to use your saved brief inside the product.',
        signInAction: 'Sign in',
        signUpAction: 'Create account',
      },
    }),
  },
  [openDraft, saveDraft, continueDraft],
);
