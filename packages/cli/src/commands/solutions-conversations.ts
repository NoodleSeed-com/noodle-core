import {
  ConversationExportClientResponseSchema,
  ConversationForgetClientResponseSchema,
  type ConversationForgetRequest,
  ConversationIdSchema,
  ConversationListClientResponseSchema,
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
  'noodle solutions conversations <list|show|export|forget> <installation> --org <org> [--conversation <id> | --customer <ref> | --participant <ref>] [--confirm]';
const ACTIONS = ['list', 'show', 'export', 'forget'] as const;
type Action = (typeof ACTIONS)[number];

interface Summary {
  readonly id: string;
  readonly channel: string;
  readonly subject: { readonly kind: string; readonly ref?: string };
  readonly lastMessageAt: string;
  readonly itemCount: number;
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
  const selectors = [args.conversation, args.customer, args.participant].filter(
    (value) => value !== undefined,
  );
  if (
    (!paging && (args.limit ?? args.cursor ?? args.channel) !== undefined) ||
    (action !== 'forget' && (args.confirm || args.customer || args.participant)) ||
    (paging && args.conversation !== undefined)
  )
    return fail(
      'Paging flags apply to list and export; --conversation to show and forget; --customer, --participant and --confirm to forget.',
    );
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
      else console.log([line(conversation), ...conversation.items.map(itemLine)].join('\n'));
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
  return `${row.lastMessageAt}  ${row.channel}  ${subject}  ${row.itemCount} item(s)  ${row.id}`;
}

function itemLine(item: Item): string {
  return item.kind === 'message'
    ? `  ${item.at}  ${item.role}: ${item.text}`
    : `  ${item.at}  outcome ${item.tool}: ${item.status}`;
}
