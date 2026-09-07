# Gmail multi-account automation

**Owns:** One reusable connector bound to independently authenticated accounts in one MCP server.

[`src/server.ts`](src/server.ts) binds `gmailConnector()` twice using `externalExchange()`. Its
`accounts` input selects either account or the ordered personal/work pair for reads. Mutations select
one account and require confirmation against that binding. The displayed email labels are fictional;
operators supply real authorization through the credential provider.

- Message/draft `raw` values are base64url-encoded RFC 2822 MIME, not separate address/body fields.
- Vacation timestamps validate digit shape; Gmail enforces the start-before-end relationship.
- Trash is reversible. Permanent deletion, sharing/delegation and arbitrary HTTP requests are absent.

## Local checks

```sh
noodle validate
noodle test
```

Tests use fake responses; they do not prove live Gmail authorization. Hosted execution requires an
operator-provided external credential exchange for each logical connection. The installed skill's
`references/authoring-workflow.md` owns binding and credential setup guidance.

## Optional application-owned gateway

The executable example calls Gmail directly. An application-owned gateway may additionally require a
service key. Gmail does not require this key, and this example supplies no gateway implementation:

```ts
import {
  bind, connection, connector, externalExchange, secret, variable, z,
} from '@noodleseed/one';

const gateway = connector('mail_gateway').version('1.0.0').http({
  baseUrl: variable('MAIL_GATEWAY_URL'),
  allowedOrigins: ['https://gateway.example.com'],
  transportAuth: {
    kind: 'apiKey',
    header: 'X-Gateway-Key',
    secret: secret('MAIL_GATEWAY_KEY'),
  },
  credentialProfiles: { account: { kind: 'bearer' } },
  operations: {
    inspect: {
      type: 'read', method: 'POST', path: '/inspect',
      credentials: { profiles: ['account'] },
      input: z.object({}),
      output: z.object({ available: z.boolean() }),
    },
  },
});

// Register this binding under server(..., { use: { mail: mailGateway } }, ...).
const mailGateway = bind(gateway, {
  profile: 'account',
  connection: connection('work_mail', externalExchange()),
});
```

The operator configures the gateway URL/key and account separately. The broker resolves both credentials;
neither belongs in tool arguments or ordinary headers. The authored compile test checks this composition,
not live gateway access. See the installed skill's `references/authoring-workflow.md` for transport rules.

## Personal automation skill

[`skills/personal-email-automation/SKILL.md`](skills/personal-email-automation/SKILL.md) is the source skill;
validate it before distribution. Canonical app-plus-skill plugin export remains roadmap work.
