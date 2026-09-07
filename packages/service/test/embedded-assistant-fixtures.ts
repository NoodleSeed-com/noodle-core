export const EMBEDDED_ASSISTANT_MANIFEST = `
manifestVersion: "1"
server:
  name: embedded
  version: 1.0.0
  title: Embedded
  instructions: Help the signed-in customer use Acme.
  branding:
    name: Acme Assistant
    accent: '#112233'
    surface: '#FFFFFF'
    surfaceDark: '#15131A'
    theme:
      dark: { accent: '#AABBCC' }
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    allowedOrigins: [https://app.example.com]
    sessionClaims:
      displayName: { exposeToModel: true }
      accountTier: { exposeToModel: true }
      region: {}
    layout: { mode: floating, position: bottom-right }
    behavior: { showConfirmationDetails: false }
    labels: { sessionReady: Acme support is online }
    presentation:
      panel: { surface: solid, elevation: dramatic, border: strong, radius: 20 }
      launcher: { icon: chat, size: lg, status: session, effect: pulse }
      header:
        mark: status
        badge: { text: ONLINE, tone: success, indicator: true }
      composer: { leadingIcon: brand-mark, sendIcon: paper-plane, shape: rounded }
      messages: { userStyle: accent, assistantStyle: bubble }
resources:
  - name: account_guide
    uri: docs://account/guide
    title: Account guide
    mimeType: text/markdown
    fulfilment:
      steps: []
      output:
        value: '# Account guide'
tools:
  - name: lookup
    description: Read account information.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        answer: ready
  - name: update_account
    description: Update account information.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      properties:
        name: { type: string }
      required: [name]
    fulfilment:
      steps: []
      output:
        updated: \${input.name}
  - name: greet
    description: Greet the customer.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    inputSchema:
      type: object
      properties:
        name: { type: string, default: world }
    fulfilment:
      steps: []
      output:
        message: Hello, \${input.name}!
  - name: whoami
    description: Report the verified signed-in identity and session claims.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        greeting: Hello, \${user.name}!
        tier: \${user.claims.accountTier}
        region: \${user.claims.region}
  - name: set_nickname
    description: Set the customer nickname.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      properties:
        nickname: { type: string, default: buddy }
    fulfilment:
      steps: []
      output:
        nickname: \${input.nickname}
`;
