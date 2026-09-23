import {
  ApplicationHistorySettingsClientResponseSchema,
  ApplicationHistorySettingsSaveClientResponseSchema,
  ApplicationHistorySettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { z } from 'zod';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  type CliFailure,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

const USAGE =
  'noodle solutions history settings <get|set> <installation> --org <org> [--activity-days <n>] [--conversation-days <n> | --conversations off] [--website-visitors on|off] [--signed-in-customers on|off] [--whatsapp on|off] [--expected-revision <hash>] [--confirm]';
const SWITCHES = {
  websiteVisitors: 'websiteVisitors',
  signedInCustomers: 'signedInCustomers',
  whatsapp: 'whatsapp',
} as const;
type Settings = z.infer<typeof ApplicationHistorySettingsClientResponseSchema>['data'];

/**
 * One installation history setting (ADR 0241 decision 6). A change that shortens or turns off
 * conversation history first runs as a dry run and needs --confirm once its effect is shown.
 */
export async function runSolutionHistory(
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
      '--expected-revision': 'expectedRevision',
      '--activity-days': 'activityDays',
      '--conversation-days': 'conversationDays',
      '--conversations': 'conversations',
      '--website-visitors': 'websiteVisitors',
      '--signed-in-customers': 'signedInCustomers',
      '--whatsapp': 'whatsapp',
    },
    booleans: { '--json': 'json', '--confirm': 'confirm' },
  });
  const fail = (message: string) =>
    printCliFailure('solutions history', usageError(message, USAGE), args.json);
  if (args.parseError) return fail(args.parseError);
  const [family, action, installation] = args.positional;
  if (
    family !== 'settings' ||
    (action !== 'get' && action !== 'set') ||
    !installation ||
    args.positional.length !== 3
  )
    return fail('Use settings get or settings set with one installation.');
  if (!args.org) return fail('--org is required.');
  const changes = [
    args.expectedRevision,
    args.activityDays,
    args.conversationDays,
    args.conversations,
    args.websiteVisitors,
    args.signedInCustomers,
    args.whatsapp,
  ];
  if (action === 'get' && (args.confirm || changes.some((value) => value !== undefined)))
    return fail('settings get takes no change, revision or --confirm flags.');
  let change: z.infer<typeof ApplicationHistorySettingsSaveRequestSchema> | undefined;
  if (action === 'set') {
    if (args.conversationDays !== undefined && args.conversations !== undefined)
      return fail('Use either --conversation-days or --conversations off, not both.');
    if (args.conversations !== undefined && args.conversations !== 'off')
      return fail('--conversations accepts only off; use --conversation-days to turn it on.');
    const sources: Partial<Record<keyof typeof SWITCHES, boolean>> = {};
    for (const key of Object.values(SWITCHES)) {
      const value = args[key];
      if (value === undefined) continue;
      if (value !== 'on' && value !== 'off') return fail(`Channel switches accept on or off.`);
      sources[key] = value === 'on';
    }
    const parsed = ApplicationHistorySettingsSaveRequestSchema.safeParse({
      expectedRevision: args.expectedRevision,
      ...(args.activityDays === undefined ? {} : { activityDays: Number(args.activityDays) }),
      ...(args.conversationDays === undefined
        ? {}
        : { conversations: { retentionDays: Number(args.conversationDays) } }),
      ...(args.conversations === 'off' ? { conversations: 'off' } : {}),
      ...(Object.keys(sources).length === 0 ? {} : { sources }),
    });
    if (!parsed.success)
      return fail(
        'settings set requires --expected-revision from settings get and at least one change; durations are 1 to 365 days within your plan maximum.',
      );
    change = parsed.data;
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (!resolved.token) return printCliFailure('solutions history', authRequired(), args.json);
  const url = `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/solution-installations/${encodeURIComponent(installation)}/history/settings`;
  const request = options.fetchImpl ?? fetch;
  const put = async (body: unknown) =>
    ApplicationHistorySettingsSaveClientResponseSchema.parse(
      await serviceJson<unknown>(
        url,
        resolved.token ?? '',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        request,
      ),
    ).data;
  try {
    if (!change) {
      const data = ApplicationHistorySettingsClientResponseSchema.parse(
        await serviceJson<unknown>(url, resolved.token, {}, request),
      ).data;
      if (args.json) printJsonOk(data);
      else console.log(describe(data));
      return EXIT.OK;
    }
    if (!args.confirm) {
      const preview = await put({ ...change, dryRun: true });
      if (preview.shortensConversations)
        return printCliFailure(
          'solutions history',
          confirmationRequired(preview.impact),
          args.json,
        );
    }
    const saved = await put(change);
    if (args.json) printJsonOk(saved);
    else
      console.log(
        [
          describe(saved.settings),
          ...(saved.shortensConversations
            ? [
                `${saved.impact.conversations} conversation(s) and ${saved.impact.items} item(s) outside the new window were hidden and will be removed.`,
              ]
            : []),
        ].join('\n'),
      );
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'solutions history',
      serviceFailure('solutions history', error, USAGE),
      args.json,
    );
  }
}

function confirmationRequired(impact: { conversations: number; items: number }): CliFailure {
  const message = `This change shortens or turns off conversation history: ${impact.conversations} conversation(s) and ${impact.items} item(s) would be hidden now and removed; a longer duration later does not restore them.`;
  return {
    code: 'confirmation_required',
    message,
    cause: message,
    fix: 'Review the effect, then re-run the same command with --confirm.',
    next: 'noodle solutions history settings set <installation> --org <org> ... --confirm',
    exitCode: EXIT.USAGE,
  };
}

const SURFACE_LABELS = {
  publicWebsite: 'public website',
  authenticatedWebsite: 'authenticated website',
  publicMessaging: 'WhatsApp',
} as const;

function describe(data: Settings): string {
  const { activity, conversations } = data;
  const channel = (on: boolean) => (on ? 'on' : 'off');
  return [
    `Activity: ${activity.retentionDays} day(s); plan maximum ${activity.maximumDays}, default ${activity.defaultDays}.`,
    conversations.state === 'on'
      ? `Conversations: ${conversations.retentionDays} day(s).`
      : conversations.state === 'off'
        ? 'Conversations: off.'
        : 'Conversations: not enabled; set --conversation-days to start recording.',
    `Recording: website visitors ${channel(conversations.sources.websiteVisitors)}, signed-in customers ${channel(conversations.sources.signedInCustomers)}, WhatsApp ${channel(conversations.sources.whatsapp)}.`,
    ...(conversations.disabledByApplication
      ? [
          `Never kept by the application (history: false in server.ts): ${conversations.disabledByApplication.map((surface) => SURFACE_LABELS[surface]).join(', ')}.`,
        ]
      : []),
    `Revision: ${data.revision}`,
    data.canEdit
      ? 'Owners and Administrators can change these settings.'
      : 'Read-only for your role.',
  ].join('\n');
}
