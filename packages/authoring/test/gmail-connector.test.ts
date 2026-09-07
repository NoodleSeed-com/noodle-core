import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateJsonSchemaWithDefaults } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import { gmailConnector } from '../src/index.js';

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const SETTINGS = 'https://www.googleapis.com/auth/gmail.settings.basic';

describe('curated Gmail connector', () => {
  it('declares one bearer profile, exact origin, workflow operations, and least-privilege scopes', () => {
    const gmail = gmailConnector();
    const definition = gmail.httpDef;
    expect(definition).toBeDefined();
    expect(definition?.http.baseUrl).toBe('https://gmail.googleapis.com');
    expect(definition?.http.allowedOrigins).toEqual(['https://gmail.googleapis.com']);
    expect(definition?.credentialProfiles).toEqual({ user_oauth: { kind: 'bearer' } });

    const operations = definition?.operations ?? {};
    expect(Object.keys(operations).sort()).toEqual(
      [
        'archive_message',
        'create_draft',
        'get_draft',
        'get_message',
        'get_thread',
        'get_vacation',
        'list_drafts',
        'modify_message_labels',
        'search_messages',
        'send_draft',
        'send_message',
        'trash_message',
        'update_draft',
        'update_vacation',
      ].sort(),
    );
    expect(
      Object.fromEntries(
        Object.entries(operations).map(([name, operation]) => [
          name,
          operation.credentials?.scopes,
        ]),
      ),
    ).toEqual({
      search_messages: [READONLY],
      get_message: [READONLY],
      get_thread: [READONLY],
      list_drafts: [READONLY],
      get_draft: [READONLY],
      create_draft: [COMPOSE],
      update_draft: [COMPOSE],
      send_draft: [COMPOSE],
      modify_message_labels: [MODIFY],
      archive_message: [MODIFY],
      send_message: [SEND],
      trash_message: [MODIFY],
      get_vacation: [SETTINGS],
      update_vacation: [SETTINGS],
    });
    for (const operation of Object.values(operations)) {
      expect(operation.credentials?.profiles).toEqual(['user_oauth']);
      expect(operation.credentials?.audience).toBe('https://gmail.googleapis.com');
    }
  });

  it('does not expose permanent deletion, delegation, sharing, or a generic request escape hatch', () => {
    const names = Object.keys(gmailConnector().httpDef?.operations ?? {});
    expect(names).not.toContain('delete_message');
    expect(names).not.toContain('delete_thread');
    expect(names).not.toContain('delete_draft');
    expect(names.some((name) => /delegate|sharing|forwarding|request/i.test(name))).toBe(false);
    expect(JSON.stringify(gmailConnector().httpDef)).not.toContain('https://mail.google.com/');
  });

  it('rejects invalid base64url, vacation times, incomplete responders, and no-op labels', () => {
    const operations = gmailConnector().httpDef?.operations;
    if (!operations) throw new Error('expected Gmail operations');

    expect(
      validateJsonSchemaWithDefaults(operations.get_message.input, { message_id: '' }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.send_message.input, { raw: 'not+base64/url' })
        .issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.send_message.input, { raw: 'A' }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.send_message.input, { raw: 'TWltZS1f' }).issues,
    ).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.modify_message_labels.input, {
        message_id: 'message-1',
      }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.modify_message_labels.input, {
        message_id: 'message-1',
        addLabelIds: [],
      }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.modify_message_labels.input, {
        message_id: 'message-1',
        removeLabelIds: ['INBOX'],
      }).issues,
    ).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: true,
        responseSubject: 'Away',
      }).issues,
    ).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: true,
        responseBodyPlainText: 'Back soon',
      }).issues,
    ).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: true,
      }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyPlainText: 'Back soon',
        startTime: '12345678901234567890',
      }).issues,
    ).not.toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: true,
        responseSubject: 'Away',
        responseBodyPlainText: 'Back soon',
        startTime: 'not-an-epoch',
      }).issues,
    ).not.toHaveLength(0);
    const validVacationIssues = validateJsonSchemaWithDefaults(operations.update_vacation.input, {
      enableAutoReply: true,
      responseSubject: 'Away',
      responseBodyPlainText: 'Back soon',
      startTime: '1893456000000',
    }).issues;
    expect(validVacationIssues).toHaveLength(0);
    expect(
      validateJsonSchemaWithDefaults(operations.update_vacation.input, {
        enableAutoReply: false,
      }).issues,
    ).toHaveLength(0);
  });
});

interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body?: unknown;
}

describe('curated Gmail HTTP mapping', () => {
  let fixture: ReturnType<typeof createServer>;
  let origin = '';
  let captured: CapturedRequest;

  beforeAll(async () => {
    fixture = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', () => {
        const bytes = Buffer.concat(chunks).toString('utf8');
        captured = {
          method: request.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: request.headers,
          ...(bytes.length > 0 ? { body: JSON.parse(bytes) as unknown } : {}),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'fixture-id', messages: [] }));
      });
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (typeof address !== 'object' || address === null) throw new Error('fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('maps all curated operations hermetically with optional omission and bearer presentation', async () => {
    const definition = structuredClone(gmailConnector().httpDef);
    if (definition === undefined) throw new Error('missing Gmail definition');
    definition.http.baseUrl = origin;
    definition.http.allowedOrigins = [origin];
    const compiled = compileConnectors(JSON.stringify({ connectors: [definition] }));
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const gmail = compiled.connectors[0];
    if (gmail === undefined) throw new Error('missing compiled Gmail connector');

    const raw = 'RmljdGl0aW91cyBNSU1F';
    const cases = [
      {
        operation: 'search_messages',
        args: { maxResults: 25 },
        method: 'GET',
        path: '/gmail/v1/users/me/messages',
        query: { maxResults: '25' },
      },
      {
        operation: 'get_message',
        args: { message_id: 'm-1', format: 'full' },
        method: 'GET',
        path: '/gmail/v1/users/me/messages/m-1',
        query: { format: 'full' },
      },
      {
        operation: 'get_thread',
        args: { thread_id: 't-1' },
        method: 'GET',
        path: '/gmail/v1/users/me/threads/t-1',
        query: {},
      },
      {
        operation: 'list_drafts',
        args: { pageToken: 'next', includeSpamTrash: false },
        method: 'GET',
        path: '/gmail/v1/users/me/drafts',
        query: { pageToken: 'next', includeSpamTrash: 'false' },
      },
      {
        operation: 'get_draft',
        args: { draft_id: 'd-1', format: 'raw' },
        method: 'GET',
        path: '/gmail/v1/users/me/drafts/d-1',
        query: { format: 'raw' },
      },
      {
        operation: 'create_draft',
        args: { raw },
        method: 'POST',
        path: '/gmail/v1/users/me/drafts',
        query: {},
        body: { message: { raw } },
      },
      {
        operation: 'update_draft',
        args: { draft_id: 'd-1', raw },
        method: 'PUT',
        path: '/gmail/v1/users/me/drafts/d-1',
        query: {},
        body: { message: { raw } },
      },
      {
        operation: 'send_draft',
        args: { draft_id: 'd-1' },
        method: 'POST',
        path: '/gmail/v1/users/me/drafts/send',
        query: {},
        body: { id: 'd-1' },
      },
      {
        operation: 'modify_message_labels',
        args: { message_id: 'm-1', removeLabelIds: ['INBOX'] },
        method: 'POST',
        path: '/gmail/v1/users/me/messages/m-1/modify',
        query: {},
        body: { removeLabelIds: ['INBOX'] },
      },
      {
        operation: 'archive_message',
        args: { message_id: 'm-1' },
        method: 'POST',
        path: '/gmail/v1/users/me/messages/m-1/modify',
        query: {},
        body: { removeLabelIds: ['INBOX'] },
      },
      {
        operation: 'send_message',
        args: { raw },
        method: 'POST',
        path: '/gmail/v1/users/me/messages/send',
        query: {},
        body: { raw },
      },
      {
        operation: 'trash_message',
        args: { message_id: 'm-1' },
        method: 'POST',
        path: '/gmail/v1/users/me/messages/m-1/trash',
        query: {},
      },
      {
        operation: 'get_vacation',
        args: {},
        method: 'GET',
        path: '/gmail/v1/users/me/settings/vacation',
        query: {},
      },
      {
        operation: 'update_vacation',
        args: {
          enableAutoReply: true,
          responseSubject: 'Away',
          responseBodyPlainText: 'Back soon',
          startTime: '1893456000000',
        },
        method: 'PUT',
        path: '/gmail/v1/users/me/settings/vacation',
        query: {},
        body: {
          enableAutoReply: true,
          responseSubject: 'Away',
          responseBodyPlainText: 'Back soon',
          startTime: '1893456000000',
        },
      },
    ] as const;

    for (const testCase of cases) {
      await gmail.invoke({
        operation: testCase.operation,
        args: testCase.args,
        credential: { token: 'fixture-token' },
        credentialPresentation: { kind: 'bearer' },
      });
      expect(captured.method, testCase.operation).toBe(testCase.method);
      expect(captured.path, testCase.operation).toBe(testCase.path);
      expect(captured.query, testCase.operation).toEqual(testCase.query);
      expect(captured.headers.authorization, testCase.operation).toBe('Bearer fixture-token');
      expect(captured.body, testCase.operation).toEqual(
        'body' in testCase ? testCase.body : undefined,
      );
      if ('body' in testCase) {
        expect(captured.headers['content-type'], testCase.operation).toBe('application/json');
      }
    }
  });
});
