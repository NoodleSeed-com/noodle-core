import {
  annotations,
  bind,
  connection,
  connector,
  externalExchange,
  gmailConnector,
  server,
  tool,
  when,
  z,
} from '@noodleseed/one';

export const PERSONAL_ACCOUNT = 'personal@example.com';
export const WORK_ACCOUNT = 'work@example.com';

const readAccounts = z.union([
  z.tuple([z.literal(PERSONAL_ACCOUNT)]).and(z.array(z.literal(PERSONAL_ACCOUNT)).length(1)),
  z.tuple([z.literal(WORK_ACCOUNT)]).and(z.array(z.literal(WORK_ACCOUNT)).length(1)),
  z
    .tuple([z.literal(PERSONAL_ACCOUNT), z.literal(WORK_ACCOUNT)])
    .and(z.array(z.enum([PERSONAL_ACCOUNT, WORK_ACCOUNT])).length(2)),
]);
const writeAccounts = z.union([
  z.tuple([z.literal(PERSONAL_ACCOUNT)]).and(z.array(z.literal(PERSONAL_ACCOUNT)).length(1)),
  z.tuple([z.literal(WORK_ACCOUNT)]).and(z.array(z.literal(WORK_ACCOUNT)).length(1)),
]);
const identifier = z.string().min(1);
const rawMessage = z.string().min(1);
const labelIds = z.array(identifier).min(1).max(100);
const epochMillis = z.string().regex(/^\d{1,19}$/);
const vacationOptionalFields = {
  restrict_to_contacts: z.boolean().optional(),
  restrict_to_domain: z.boolean().optional(),
  start_time: epochMillis.optional(),
  end_time: epochMillis.optional(),
};
// One shared output shape for every tool: one entry per account the call fanned out to. The cap is
// exactly the number of canonical accounts, so it is a true bound rather than a guess — `noodle check`
// reports an unbounded array output as `tool_design_output_bounds`.
const output = z.object({
  results: z
    .array(z.object({ account: z.enum([PERSONAL_ACCOUNT, WORK_ACCOUNT]), data: z.unknown() }))
    .max(2),
});

const gmail = gmailConnector();
const personal = connection('personal_gmail', externalExchange());
const work = connection('work_gmail', externalExchange());

const merge = connector('gmail_account_results')
  .version('1.0.0')
  .compute('merge', {
    type: 'read',
    input: z.object({
      personal: z.unknown().optional(),
      work_first: z.unknown().optional(),
      work_second: z.unknown().optional(),
    }),
    output,
    run: (input) => {
      const results: Array<{ account: string; data: unknown }> = [];
      if (input.personal !== undefined) {
        results.push({ account: 'personal@example.com', data: input.personal });
      }
      const workData = input.work_first ?? input.work_second;
      if (workData !== undefined) {
        results.push({ account: 'work@example.com', data: workData });
      }
      return { results };
    },
  });

const confirmedWrite = annotations.openAction({ destructive: false, confirm: true });
const confirmedTrash = annotations.openAction({ destructive: true, confirm: true });

export default server(
  'gmail_multi_account',
  {
    title: 'Gmail Multi-Account Automation',
    version: '1.0.0',
    use: {
      personal_gmail: bind(gmail, { profile: 'user_oauth', connection: personal }),
      work_gmail: bind(gmail, { profile: 'user_oauth', connection: work }),
      gmail_results: merge,
    },
  },
  [
    tool('search_messages', {
      title: 'Search messages',
      description: 'Search one connected Gmail account or the canonical personal-and-work pair.',
      input: z.object({
        accounts: readAccounts,
        query: z.string(),
        max_results: z.number().int().min(1).max(500).optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.search_messages({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.search_messages({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.search_messages({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('get_message', {
      title: 'Get message',
      description: 'Get one Gmail message from one connected account or both canonical accounts.',
      input: z.object({
        accounts: readAccounts,
        message_id: identifier,
        format: z.enum(['minimal', 'full', 'raw', 'metadata']).optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.get_message({
            message_id: input.message_id,
            format: input.format,
          }),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_message({
            message_id: input.message_id,
            format: input.format,
          }),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_message({
            message_id: input.message_id,
            format: input.format,
          }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('get_thread', {
      title: 'Get thread',
      description: 'Get one Gmail thread from one connected account or both canonical accounts.',
      input: z.object({
        accounts: readAccounts,
        thread_id: identifier,
        format: z.enum(['minimal', 'full', 'metadata']).optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.get_thread({
            thread_id: input.thread_id,
            format: input.format,
          }),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_thread({
            thread_id: input.thread_id,
            format: input.format,
          }),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_thread({
            thread_id: input.thread_id,
            format: input.format,
          }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('list_drafts', {
      title: 'List drafts',
      description: 'List drafts from one connected Gmail account or both canonical accounts.',
      input: z.object({
        accounts: readAccounts,
        query: z.string().optional(),
        max_results: z.number().int().min(1).max(500).optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.list_drafts({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.list_drafts({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.list_drafts({
            q: input.query,
            maxResults: input.max_results,
          }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('get_draft', {
      title: 'Get draft',
      description: 'Get one draft from one connected Gmail account or both canonical accounts.',
      input: z.object({
        accounts: readAccounts,
        draft_id: identifier,
        format: z.enum(['minimal', 'full', 'raw', 'metadata']).optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.get_draft({
            draft_id: input.draft_id,
            format: input.format,
          }),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_draft({
            draft_id: input.draft_id,
            format: input.format,
          }),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_draft({
            draft_id: input.draft_id,
            format: input.format,
          }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('get_vacation', {
      title: 'Get vacation responder',
      description: 'Read vacation-responder settings from one connected account or both accounts.',
      input: z.object({ accounts: readAccounts }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.get_vacation({}),
        );
        const workFirst = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_vacation({}),
        );
        const workSecond = when(input.accounts.at(1).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.get_vacation({}),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: workFirst.data.optional(),
          work_second: workSecond.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('create_draft', {
      title: 'Create draft',
      description:
        'Create a Gmail draft in exactly one selected account from a base64url MIME message.',
      annotations: confirmedWrite,
      input: z.object({ accounts: writeAccounts, raw: rawMessage }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.create_draft({ raw: input.raw }),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.create_draft({ raw: input.raw }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('update_draft', {
      title: 'Update draft',
      description:
        'Replace a Gmail draft in exactly one selected account with a base64url MIME message.',
      annotations: confirmedWrite,
      input: z.object({ accounts: writeAccounts, draft_id: identifier, raw: rawMessage }),
      output,
      fulfil: ({ input, connectors }) => {
        const args = { draft_id: input.draft_id, raw: input.raw };
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.update_draft(args),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.update_draft(args),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('send_draft', {
      title: 'Send draft',
      description: 'Send an existing Gmail draft from exactly one selected account.',
      annotations: confirmedWrite,
      input: z.object({ accounts: writeAccounts, draft_id: identifier }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.send_draft({ draft_id: input.draft_id }),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.send_draft({ draft_id: input.draft_id }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('modify_message_labels', {
      title: 'Change message labels',
      description: 'Add or remove Gmail label ids on one message in exactly one selected account.',
      annotations: confirmedWrite,
      input: z.object({
        accounts: writeAccounts,
        message_id: identifier,
        add_label_ids: labelIds.optional(),
        remove_label_ids: labelIds.optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const args = {
          message_id: input.message_id,
          addLabelIds: input.add_label_ids,
          removeLabelIds: input.remove_label_ids,
        };
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.modify_message_labels(args),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.modify_message_labels(args),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('archive_message', {
      title: 'Archive message',
      description: 'Archive one Gmail message in exactly one account by removing INBOX.',
      annotations: confirmedWrite,
      input: z.object({ accounts: writeAccounts, message_id: identifier }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.archive_message({ message_id: input.message_id }),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.archive_message({ message_id: input.message_id }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('send_message', {
      title: 'Send message',
      description: 'Send one base64url MIME message from exactly one selected Gmail account.',
      annotations: confirmedWrite,
      input: z.object({
        accounts: writeAccounts,
        raw: rawMessage,
        thread_id: identifier.optional(),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const args = { raw: input.raw, threadId: input.thread_id };
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.send_message(args),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.send_message(args),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('trash_message', {
      title: 'Move message to trash',
      description: 'Move one Gmail message to trash in exactly one account. This is reversible.',
      annotations: confirmedTrash,
      input: z.object({ accounts: writeAccounts, message_id: identifier }),
      output,
      fulfil: ({ input, connectors }) => {
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.trash_message({ message_id: input.message_id }),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.trash_message({ message_id: input.message_id }),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
    tool('update_vacation', {
      title: 'Update vacation responder',
      description: 'Update vacation-responder settings on exactly one selected Gmail account.',
      annotations: confirmedWrite,
      input: z.object({
        accounts: writeAccounts,
        settings: z.union([
          z.object({
            enable_auto_reply: z.literal(false),
            response_subject: z.string().min(1).optional(),
            response_body_plain_text: z.string().min(1).optional(),
            ...vacationOptionalFields,
          }),
          z.object({
            enable_auto_reply: z.literal(true),
            response_subject: z.string().min(1),
            response_body_plain_text: z.string().min(1).optional(),
            ...vacationOptionalFields,
          }),
          z.object({
            enable_auto_reply: z.literal(true),
            response_subject: z.string().min(1).optional(),
            response_body_plain_text: z.string().min(1),
            ...vacationOptionalFields,
          }),
        ]),
      }),
      output,
      fulfil: ({ input, connectors }) => {
        const args = {
          enableAutoReply: input.settings.enable_auto_reply,
          responseSubject: input.settings.response_subject,
          responseBodyPlainText: input.settings.response_body_plain_text,
          restrictToContacts: input.settings.restrict_to_contacts,
          restrictToDomain: input.settings.restrict_to_domain,
          startTime: input.settings.start_time,
          endTime: input.settings.end_time,
        };
        const personal = when(input.accounts.at(0).equals(PERSONAL_ACCOUNT), () =>
          connectors.personal_gmail.update_vacation(args),
        );
        const work = when(input.accounts.at(0).equals(WORK_ACCOUNT), () =>
          connectors.work_gmail.update_vacation(args),
        );
        const merged = connectors.gmail_results.merge({
          personal: personal.data.optional(),
          work_first: work.data.optional(),
        });
        return { results: merged.results };
      },
    }),
  ],
);
