import type { ConfigLocation } from '../config.js';
import { serviceJson } from '../control-plane.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { EXIT, printJsonOk } from './output.js';
import {
  parseTenantCommandArgs,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
} from './shared.js';

/**
 * Operating a public website surface: what it is, and what it may spend.
 *
 * `budget set --turns-per-day 0` is the kill switch, and deliberately the only one documented. Revoking
 * an embed would also stop a surface, but it destroys the paste-once id and every page already carrying
 * it — recovery means editing the customer's HTML, not raising a number back.
 */

export interface AssistantEmbedView {
  readonly embedId: string;
  readonly surfaceMode: string;
  readonly origins: readonly string[];
  readonly capabilities: readonly string[];
  readonly turnsPerDay: number;
  readonly mintsPerDay: number;
  readonly bridgeCallsPerSession: number;
  readonly bridgeCallsPerDay: number;
  readonly budgetIsDefault: boolean;
  readonly turnsToday: number;
  readonly mintsToday: number;
  readonly bridgeCallsToday: number;
  /** Present only on a surface Noodle is funding; absent means the caps above are the whole story. */
  readonly managedSpend?: {
    readonly state: string;
    readonly turnsRemaining: number;
    readonly visitors: string;
  };
}

export function formatEmbedLines(embed: AssistantEmbedView): readonly string[] {
  const source = embed.budgetIsDefault ? ' (default)' : '';
  return [
    `${embed.embedId}  ${embed.surfaceMode}`,
    `  Origins       ${embed.origins.join(', ') || '(none — no active public surface)'}`,
    `  Capabilities  ${embed.capabilities.join(', ') || '(none)'}`,
    // Today's spend beside the cap, because "is my budget about to run out" is the question an
    // operator opens this command to answer.
    `  Turns today   ${embed.turnsToday} / ${embed.turnsPerDay}${source}`,
    `  Mints today   ${embed.mintsToday} / ${embed.mintsPerDay}${source}`,
    // A bridge call spends neither a turn nor a mint, so an operator watching only the two lines
    // above would read browser-agent traffic as a quiet day.
    `  Bridge today  ${embed.bridgeCallsToday} / ${embed.bridgeCallsPerDay}${source}  (${embed.bridgeCallsPerSession} per session)`,
    ...managedSpendLines(embed),
    ...statusLine(embed),
  ];
}

/**
 * What the platform is doing to this surface, which the caps above cannot show.
 *
 * A sponsored surface degrades before it closes, and from the caps alone that is invisible — they
 * read normal right up to the moment the ladder shuts them. Remaining turns rather than a
 * percentage: the spend consume is all-or-nothing, so a costly turn is refused while a cheap one
 * still passes, and a percentage would look like it stopped early. An operator who wants this ceiling
 * gone connects their own model key and redeploys.
 */
function managedSpendLines(embed: AssistantEmbedView): readonly string[] {
  const spend = embed.managedSpend;
  if (spend === undefined) return [];
  return [
    `  Noodle-funded ${spend.state} — about ${spend.turnsRemaining.toLocaleString()} turns left today`,
    `                ${spend.visitors}`,
  ];
}

/**
 * The two caps are independent doors, so only both of them shut is "off".
 *
 * Reporting either zero as OFF is the answer an operator most needs to be right during a kill-switch
 * rehearsal, and it was wrong: `turnsPerDay 0` refuses every conversation while minting keeps writing
 * session rows, and `mintsPerDay 0` turns away new visitors while sessions already open keep talking.
 */
function statusLine(embed: AssistantEmbedView): readonly string[] {
  const turnsShut = embed.turnsPerDay === 0;
  const mintsShut = embed.mintsPerDay === 0;
  if (turnsShut && mintsShut) {
    return ['  Status        OFF — raise both caps to serve visitors again'];
  }
  if (turnsShut) {
    return ['  Status        no conversations, still minting — set --mints-per-day 0 to close it'];
  }
  if (mintsShut) {
    return ['  Status        no new visitors, open sessions continue until they expire'];
  }
  return [];
}

/**
 * The budget flags, where 0 is a value and absence means "leave that cap alone".
 *
 * The two daily caps are what an operator reaches for; the two hourly per-address caps are the abuse
 * bounds, listed because a cap the service enforces and the CLI cannot reach is a cap nobody can
 * operate. Per-visitor fairness is deliberately not here: it is not an operator's to tune, and
 * lowering it would only make their own site worse for people behind a shared address.
 */
export function parseBudgetFlags(
  rest: readonly string[],
):
  | { readonly ok: true; readonly body: Record<string, number> }
  | { readonly ok: false; readonly error: string } {
  const body: Record<string, number> = {};
  for (const [flag, field] of [
    ['--turns-per-day', 'turnsPerDay'],
    ['--mints-per-day', 'mintsPerDay'],
    ['--mints-per-address-hour', 'mintsPerAddressHour'],
    ['--turns-per-address-hour', 'turnsPerAddressHour'],
    ['--bridge-calls-per-session', 'bridgeToolCallsPerSession'],
    ['--bridge-calls-per-day', 'bridgeToolCallsPerDay'],
  ] as const) {
    const at = rest.indexOf(flag);
    if (at === -1) continue;
    const raw = rest[at + 1];
    const value = Number(raw);
    // A blank argument is rejected rather than read as `Number('') === 0`, because zero is the
    // kill switch: an emptied argument would otherwise close a surface without saying so.
    if (raw === undefined || raw.trim() === '' || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: `${flag} requires a non-negative whole number` };
    }
    body[field] = value;
  }
  if (Object.keys(body).length === 0) {
    return {
      ok: false,
      error:
        'set at least one of --turns-per-day, --mints-per-day, --mints-per-address-hour, --turns-per-address-hour, --bridge-calls-per-session or --bridge-calls-per-day',
    };
  }
  return { ok: true, body };
}

export async function runAssistantEmbeds(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  if (rest[0] !== 'list') {
    return printCommandUsageFailure(
      'assistant',
      'noodle assistant embeds requires list',
      'noodle assistant embeds --help',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<{ readonly embeds: readonly AssistantEmbedView[] }>(
      `${resolved.base}/assistant/embeds`,
      resolved.token,
    );
    if (args.json) printJsonOk({ embeds: body.embeds });
    else if (body.embeds.length === 0) {
      console.log(
        'No public assistant surfaces. Deploy an app with a public website surface first.',
      );
    } else {
      for (const embed of body.embeds)
        for (const line of formatEmbedLines(embed)) console.log(line);
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant embeds list'),
      args.json,
    );
  }
}

export async function runAssistantBudget(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  if (rest[0] !== 'set') {
    return printCommandUsageFailure(
      'assistant',
      'noodle assistant budget requires set',
      'noodle assistant budget --help',
      args.json,
    );
  }
  const surfaceAt = rest.indexOf('--surface');
  const surface = surfaceAt === -1 ? undefined : rest[surfaceAt + 1];
  const budget = parseBudgetFlags(rest);
  if (!budget.ok) {
    return printCommandUsageFailure(
      'assistant',
      budget.error,
      'noodle assistant budget set --help',
      args.json,
    );
  }

  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    // Without `--surface`, apply to the tenant's one public surface — the ordinary case, since an app
    // has at most one. More than one is ambiguous and says so rather than picking.
    let target = surface;
    if (target === undefined) {
      const listed = await serviceJson<{ readonly embeds: readonly AssistantEmbedView[] }>(
        `${resolved.base}/assistant/embeds`,
        resolved.token,
      );
      if (listed.embeds.length !== 1) {
        return printCommandUsageFailure(
          'assistant',
          listed.embeds.length === 0
            ? 'this app has no public assistant surface'
            : 'more than one public surface — name it with --surface <embed-id>',
          'noodle assistant embeds list',
          args.json,
        );
      }
      target = listed.embeds[0]?.embedId as string;
    }
    const body = await serviceJson<{ readonly embed: AssistantEmbedView }>(
      `${resolved.base}/assistant/embeds/${encodeURIComponent(target)}`,
      resolved.token,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(budget.body),
      },
    );
    if (args.json) printJsonOk({ embed: body.embed });
    else for (const line of formatEmbedLines(body.embed)) console.log(line);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant budget set'),
      args.json,
    );
  }
}
