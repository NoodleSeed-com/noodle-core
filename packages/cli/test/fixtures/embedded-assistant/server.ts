import {
  annotations,
  authenticatedWebsite,
  embeddedAssistant,
  openAICompatible,
  secret,
  server,
  tool,
  variable,
  z,
} from '@noodleseed/one';

export default server(
  'embedded_assistant',
  {
    title: 'Embedded Assistant',
    version: '1.0.0',
    branding: {
      name: 'Example Assistant',
      accent: '#5544EE',
      theme: { light: { accent: '#5544EE' }, dark: { accent: '#AA99FF' } },
      colorScheme: 'auto',
    },
    assistant: embeddedAssistant({
      model: openAICompatible({
        baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
        model: variable('ASSISTANT_MODEL'),
        apiKey: secret('ASSISTANT_MODEL_API_KEY'),
      }),
      access: authenticatedWebsite({
        origins: ['https://app.example.com'],
        sessionClaims: {
          displayName: { exposeToModel: true },
          accountTier: {},
        },
      }),
    }),
  },
  [
    tool('lookup', {
      description: 'Read the signed-in customer account details.',
      input: z.object({}),
      annotations: annotations.readOnly(),
      fulfil: ({ user }) => ({ ok: true, greeting: `Hello, ${user.name}!`, tier: user.claims.accountTier }),
    }),
  ],
);
