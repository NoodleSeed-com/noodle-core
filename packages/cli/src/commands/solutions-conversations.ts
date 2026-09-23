import {
  ConversationExportClientResponseSchema,
  ConversationForgetClientResponseSchema,
  type ConversationForgetRequest,
  ConversationIdSchema,
  ConversationListClientResponseSchema,
  type ConversationReviewRequest,
  ConversationReviewRequestSchema,
  type ConversationReviewStatus,
  ConversationShowClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

const USAGE =
  'noodle solutions conversations <list|show|review|note|export|forget> <installation> --org <org> [--conversation <id> | --customer <ref> | --participant <ref>] [--status <new|needs-attention|reviewed>] [--text <note>] [--confirm]';
const ACTIONS = ['list', 'show', 'review', 'note', 'export', 'forget'] as const;
type Action = (typeof ACTIONS)[number];
/** CLI spellings of the wire review statuses. */
const STATUSES: Readonly<Record<string, ConversationReviewStatus>> = {
  new: 'new',
  'needs-attention': 'needs_attention',
  reviewed: 'reviewed',
};
const STATUS_LABELS: Readonly<Record<string, string>> = {
  new: 'new',
  needs_attention: 'needs attention',
  reviewed: 'reviewed',
};

interface Summary {
  readonly id: string;
  readonly channel: string;
  readonly subject: { readonly kind: string; readonly ref?: string };
  readonly lastMessageAt: string;
  readonly itemCount: number;
  readonly reviewStatus?: string;
}
interface Item {
  readonly kind: 'message' | 'outcome';
  readonly at: string;
  readonly role?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly status?: string;
}

/** Staff projection of conversation history; every read and erasure is audited by the service. */
export async function runSolutionConversations(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const args = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--limit': 'limit',
      '--cursor': 'cursor',
      '--channel': 'channel',
      '--status': 'status',
      '--text': 'text',
      '--conversation': 'conversation',
      '--customer': 'customer',
      '--participant': 'participant',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const fail = (message: string) =>
    printCliFailure('solutions conversations', usageError(message, USAGE), args.json);
  if (args.parseError) return fail(args.parseError);
  const [family, installation] = args.positional;
  if (!ACTIONS.includes(family as Action) || !installation || args.positional.length !== 2)
    return fail('A supported action and one installation are required.');
  if (!args.org) return fail('--org is required.');
  const action = family as Action;
  const paging = action === 'list' || action === 'export';
  const reviewing = action === 'review' || action === 'note';
  const selectors = [args.conversation, args.customer, args.participant].filter(
    (value) => value !== undefined,
  );
  if (
    (!paging && (args.limit ?? args.cursor ?? args.channel) !== undefined) ||
    (!paging && action !== 'review' && args.status !== undefined) ||
    (action !== 'note' && args.text !== undefined) ||
    (action !== 'forget' && (args.confirm || args.customer || args.participant)) ||
    (paging && args.conversation !== undefined)
  )
    return fail(
      'Paging flags apply to list and export; --status to list, export and review; --text to note; --conversation to show, review, note and forget; --customer, --participant and --confirm to forget.',
    );
  const status = args.status === undefined ? undefined : STATUSES[args.status];
  if (args.status !== undefined && status === undefined)
    return fail('--status must be new, needs-attention or reviewed.');
  let review: ConversationReviewRequest | undefined;
  if (reviewing) {
    if (!ConversationIdSchema.safeParse(args.conversation).success)
      return fail(`${action} requires --conversation with an id from conversations list.`);
    const parsed = ConversationReviewRequestSchema.safeParse(
      action === 'review' ? { reviewStatus: status } : { note: args.text },
    );
    if (!parsed.success)
      return fail(
        action === 'review'
          ? 'review requires --status new, needs-attention or reviewed.'
          : 'note requires --text of 1 to 2000 characters.',
      );
    review = parsed.data;
  }
  const maximum = action === 'export' ? 25 : 100;
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > maximum))
    return fail(`--limit must be an integer from 1 to ${maximum}.`);
  if (args.cursor !== undefined && (args.cursor.length === 0 || args.cursor.length > 2048))
    return fail('--cursor must be a bounded opaque cursor.');
  if (args.channel !== undefined && args.channel !== 'website' && args.channel !== 'whatsapp')
    return fail('--channel must be website or whatsapp.');
  if (action === 'show' && !ConversationIdSchema.safeParse(args.conversation).success)
    return fail('show requires --conversation with an id from conversations list.');
  let forget: ConversationForgetRequest | undefined;
  if (action === 'forget') {
    if (selectors.length !== 1)
      return fail('forget requires exactly one of --conversation, --customer or --participant.');
    if (
      args.conversation !== undefined &&
      !ConversationIdSchema.safeParse(args.conversation).success
    )
      return fail('--conversation must be an id from conversations list.');
    if (!args.confirm)
      return fail('--confirm is required to permanently erase conversation history.');
    forget =
      args.conversation !== undefined
        ? { conversationId: args.conversation }
        : {
            subject: {
              kind: args.customer !== undefined ? 'customer' : 'participant',
              ref: String(args.customer ?? args.participant),
            },
          };
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure('solutions conversations', authRequired(), args.json);
  const base = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/conversations`;
  const request = options.fetchImpl ?? fetch;
  try {
    if (paging) {
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      if (args.cursor !== undefined) query.set('cursor', args.cursor);
      if (args.channel !== undefined) query.set('channel', args.channel);
      if (status !== undefined) query.set('status', status);
      const response = await serviceJson<unknown>(
        `${base}${action === 'export' ? '/export' : ''}${query.size ? `?${query}` : ''}`,
        resolved.token,
        {},
        request,
      );
      const exported =
        action === 'export'
          ? ConversationExportClientResponseSchema.parse(response).data
          : undefined;
      const data = exported ?? ConversationListClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk(data);
      else
        console.log(
          [
            ...(exported
              ? exported.conversations.flatMap((row) => [line(row), ...row.items.map(itemLine)])
              : data.conversations.map(line)),
            ...(data.conversations.length === 0 ? ['No conversations in this page.'] : []),
            ...(data.nextCursor === undefined ? [] : [`Next cursor: ${data.nextCursor}`]),
          ].join('\n'),
        );
    } else if (action === 'show') {
      const response = await serviceJson<unknown>(
        `${base}/${encodeURIComponent(String(args.conversation))}`,
        resolved.token,
        {},
        request,
      );
      const { conversation } = ConversationShowClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk({ conversation });
      else
        console.log(
          [
            line(conversation),
            ...conversation.items.map(itemLine),
            ...conversation.notes.map((note) => `  ${note.at}  note ${note.author}: ${note.text}`),
            `Removed automatically on ${conversation.expiresAt}.`,
          ].join('\n'),
        );
    } else if (review) {
      const response = await serviceJson<unknown>(
        `${base}/${encodeURIComponent(String(args.conversation))}`,
        resolved.token,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(review),
        },
        request,
      );
      const { conversation } = ConversationShowClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk({ conversation });
      else
        console.log(
          action === 'review'
            ? `Conversation ${conversation.id} marked ${label(conversation.reviewStatus)}.`
            : `Conversation ${conversation.id} now has ${conversation.notes.length} private note(s); customers never see notes.`,
        );
    } else {
      const response = await serviceJson<unknown>(
        `${base}/forget`,
        resolved.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(forget),
        },
        request,
      );
      const { forgotten } = ConversationForgetClientResponseSchema.parse(response).data;
      if (args.json) printJsonOk({ forgotten });
      else
        console.log(
          `Erased ${forgotten.conversations} conversation(s) and ${forgotten.items} message or outcome item(s).`,
        );
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions conversations',
      serviceFailure('solutions conversations', error, USAGE),
      args.json,
    );
  }
}

function line(row: Summary): string {
  const subject =
    row.subject.ref === undefined ? row.subject.kind : `${row.subject.kind} ${row.subject.ref}`;
  return `${row.lastMessageAt}  ${row.channel}  ${subject}  ${label(row.reviewStatus)}  ${row.itemCount} item(s)  ${row.id}`;
}

function label(status: string | undefined): string {
  return STATUS_LABELS[status ?? 'new'] ?? String(status);
}

function itemLine(item: Item): string {
  return item.kind === 'message'
    ? `  ${item.at}  ${item.role}: ${item.text}`
    : `  ${item.at}  outcome ${item.tool}: ${item.status}`;
}
