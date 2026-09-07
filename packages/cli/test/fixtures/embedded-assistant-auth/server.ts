import {
  annotations,
  customerAuth,
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
  'embedded_assistant_auth',
  {
    title: 'Embedded Assistant (customer auth)',
    version: '1.0.0',
    auth: customerAuth.oidc({
      issuer: 'https://id.example.com',
      audience: 'api://embedded-assistant',
    }),
    assistant: embeddedAssistant({
      model: openAICompatible({
        baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
        model: variable('ASSISTANT_MODEL'),
        apiKey: secret('ASSISTANT_MODEL_API_KEY'),
      }),
      access: authenticatedWebsite({ origins: ['https://app.example.com'] }),
    }),
  },
  [
    tool('lookup', {
      description: 'Read the signed-in customer account details.',
      input: z.object({}),
      annotations: annotations.readOnly(),
      fulfil: () => ({ ok: true }),
    }),
  ],
);
