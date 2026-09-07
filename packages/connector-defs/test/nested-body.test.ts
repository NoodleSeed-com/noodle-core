import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

/** A stub backing server that parses the JSON request body and echoes it back, plus a nested field. */
function echoBodyServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      // Mirror the body and expose a deep field so the response mapping can read choices[0]...
      res.end(JSON.stringify({ received: body, choices: [{ message: { content: 'ok' } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('declarative connector — nested request body', () => {
  it('builds a nested object/array body from args and reads a deep response path', async () => {
    const { server, url } = await echoBodyServer();
    try {
      const result = compileConnectors(`
connectors:
  - id: chat
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
    operations:
      ask:
        type: action
        method: POST
        path: /v1/chat
        input:
          type: object
          properties:
            query: { type: string }
            model: { type: string }
          required: [query]
          additionalProperties: false
        output:
          type: object
          properties:
            answer: { type: string }
            echoedModel: { type: string }
            echoedContent: { type: string }
          additionalProperties: false
        request:
          model: \${args.model}
          messages:
            - role: user
              content: \${args.query}
        response:
          answer: \${response.choices[0].message.content}
          echoedModel: \${response.received.model}
          echoedContent: \${response.received.messages[0].content}
`);
      if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
      const out = await result.connectors[0]?.invoke({
        operation: 'ask',
        args: { query: 'why is the sky blue?', model: 'sonar' },
        credential: { token: '' },
      });
      expect(out).toEqual({
        answer: 'ok',
        echoedModel: 'sonar',
        echoedContent: 'why is the sky blue?',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
