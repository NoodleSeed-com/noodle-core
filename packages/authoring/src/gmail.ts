import { z } from 'zod';
import { type ConnectorBuilder, connector } from './connectors.js';

const ORIGIN = 'https://gmail.googleapis.com';
const PROFILE = 'user_oauth' as const;

const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const SETTINGS = 'https://www.googleapis.com/auth/gmail.settings.basic';

const responseData = z.object({ data: z.unknown() });
const responseMap = { data: '${response}' } as const;
const identifier = z.string().min(1);
const rawMessage = z
  .string()
  .regex(
    /^(?=.+)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?|[A-Za-z0-9_-]{4})?$/,
    'expected RFC 4648 base64url bytes',
  );
const vacationProperties = {
  responseSubject: { type: 'string', minLength: 1 },
  responseBodyPlainText: { type: 'string', minLength: 1 },
  responseBodyHtml: { type: 'string', minLength: 1 },
  restrictToContacts: { type: 'boolean' },
  restrictToDomain: { type: 'boolean' },
  startTime: { type: 'string', pattern: '^\\d{1,19}$', maxLength: 19 },
  endTime: { type: 'string', pattern: '^\\d{1,19}$', maxLength: 19 },
} as const;

const vacationSettingsInput = {
  type: 'object',
  additionalProperties: false,
  properties: { enableAutoReply: { type: 'boolean' }, ...vacationProperties },
  required: ['enableAutoReply'],
  oneOf: [
    {
      properties: { enableAutoReply: { const: false } },
    },
    {
      properties: { enableAutoReply: { const: true } },
      anyOf: [
        { required: ['responseSubject'] },
        { required: ['responseBodyPlainText'] },
        { required: ['responseBodyHtml'] },
      ],
    },
  ],
} as const;

function credentials(scope: string): {
  profiles: string[];
  scopes: string[];
  audience: string;
} {
  return {
    profiles: [PROFILE],
    scopes: [scope],
    audience: ORIGIN,
  };
}

/**
 * Build Noodle's curated Gmail REST connector. It declares transport and credential requirements only;
 * applications bind it to one or more logical connections with `bind(...)`.
 */
export function gmailConnector(): ConnectorBuilder<'user_oauth'> {
  return connector('gmail')
    .version('1.0.0')
    .http({
      baseUrl: ORIGIN,
      allowedOrigins: [ORIGIN],
      credentialProfiles: { user_oauth: { kind: 'bearer' } },
      operations: {
        search_messages: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/messages',
          query: ['q', 'maxResults', 'pageToken', 'includeSpamTrash'],
          input: z.object({
            q: z.string().optional(),
            maxResults: z.number().int().min(1).max(500).optional(),
            pageToken: z.string().optional(),
            includeSpamTrash: z.boolean().optional(),
          }),
          output: responseData,
          response: responseMap,
          credentials: credentials(READONLY),
        },
        get_message: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/messages/${args.message_id}',
          query: ['format'],
          input: z.object({
            message_id: identifier,
            format: z.enum(['minimal', 'full', 'raw', 'metadata']).optional(),
          }),
          output: responseData,
          response: responseMap,
          credentials: credentials(READONLY),
        },
        get_thread: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/threads/${args.thread_id}',
          query: ['format'],
          input: z.object({
            thread_id: identifier,
            format: z.enum(['minimal', 'full', 'metadata']).optional(),
          }),
          output: responseData,
          response: responseMap,
          credentials: credentials(READONLY),
        },
        list_drafts: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/drafts',
          query: ['q', 'maxResults', 'pageToken', 'includeSpamTrash'],
          input: z.object({
            q: z.string().optional(),
            maxResults: z.number().int().min(1).max(500).optional(),
            pageToken: z.string().optional(),
            includeSpamTrash: z.boolean().optional(),
          }),
          output: responseData,
          response: responseMap,
          credentials: credentials(READONLY),
        },
        get_draft: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/drafts/${args.draft_id}',
          query: ['format'],
          input: z.object({
            draft_id: identifier,
            format: z.enum(['minimal', 'full', 'raw', 'metadata']).optional(),
          }),
          output: responseData,
          response: responseMap,
          credentials: credentials(READONLY),
        },
        create_draft: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/drafts',
          input: z.object({ raw: rawMessage }),
          request: { message: { raw: '${args.raw}' } },
          output: responseData,
          response: responseMap,
          credentials: credentials(COMPOSE),
        },
        update_draft: {
          type: 'action',
          method: 'PUT',
          path: '/gmail/v1/users/me/drafts/${args.draft_id}',
          input: z.object({ draft_id: identifier, raw: rawMessage }),
          request: {
            message: { raw: '${args.raw}' },
          },
          output: responseData,
          response: responseMap,
          credentials: credentials(COMPOSE),
        },
        send_draft: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/drafts/send',
          input: z.object({ draft_id: identifier }),
          request: { id: '${args.draft_id}' },
          output: responseData,
          response: responseMap,
          credentials: credentials(COMPOSE),
        },
        modify_message_labels: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/messages/${args.message_id}/modify',
          input: {
            type: 'object',
            additionalProperties: false,
            properties: {
              message_id: { type: 'string', minLength: 1 },
              addLabelIds: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'string', minLength: 1 },
              },
              removeLabelIds: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: { type: 'string', minLength: 1 },
              },
            },
            required: ['message_id'],
            anyOf: [{ required: ['addLabelIds'] }, { required: ['removeLabelIds'] }],
          },
          request: {
            addLabelIds: '${args.addLabelIds}',
            removeLabelIds: '${args.removeLabelIds}',
          },
          output: responseData,
          response: responseMap,
          credentials: credentials(MODIFY),
        },
        archive_message: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/messages/${args.message_id}/modify',
          input: z.object({ message_id: identifier }),
          request: { removeLabelIds: ['INBOX'] },
          output: responseData,
          response: responseMap,
          credentials: credentials(MODIFY),
        },
        send_message: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/messages/send',
          input: z.object({ raw: rawMessage, threadId: identifier.optional() }),
          request: { raw: '${args.raw}', threadId: '${args.threadId}' },
          output: responseData,
          response: responseMap,
          credentials: credentials(SEND),
        },
        trash_message: {
          type: 'action',
          method: 'POST',
          path: '/gmail/v1/users/me/messages/${args.message_id}/trash',
          input: z.object({ message_id: identifier }),
          output: responseData,
          response: responseMap,
          credentials: credentials(MODIFY),
        },
        get_vacation: {
          type: 'read',
          method: 'GET',
          path: '/gmail/v1/users/me/settings/vacation',
          input: z.object({}),
          output: responseData,
          response: responseMap,
          credentials: credentials(SETTINGS),
        },
        update_vacation: {
          type: 'action',
          method: 'PUT',
          path: '/gmail/v1/users/me/settings/vacation',
          input: vacationSettingsInput,
          request: {
            enableAutoReply: '${args.enableAutoReply}',
            responseSubject: '${args.responseSubject}',
            responseBodyPlainText: '${args.responseBodyPlainText}',
            responseBodyHtml: '${args.responseBodyHtml}',
            restrictToContacts: '${args.restrictToContacts}',
            restrictToDomain: '${args.restrictToDomain}',
            startTime: '${args.startTime}',
            endTime: '${args.endTime}',
          },
          output: responseData,
          response: responseMap,
          credentials: credentials(SETTINGS),
        },
      },
    });
}
