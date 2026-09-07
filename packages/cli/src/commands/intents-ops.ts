import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { serviceJson } from '../control-plane.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { EXIT, printJsonOk } from './output.js';
import {
  parseCommandFlags,
  parseTenantCommandArgs,
  printCliFailure,
  serviceFailure,
  usage,
} from './shared.js';

interface IntentStatusResponse {
  readonly ok: true;
  readonly data: {
    readonly mode: 'off' | 'starter-v1';
    readonly retentionDays: number;
    readonly taxonomy: string;
  };
}

interface IntentInsightsResponse {
  readonly ok: true;
  readonly data: {
    readonly mode: 'off' | 'starter-v1';
    readonly coverage: {
      readonly captured: number;
      readonly toolCalls: number;
      readonly rate: number;
    };
    readonly byCategory: readonly { readonly key: string; readonly count: number }[];
    readonly byMatch: readonly { readonly key: string; readonly count: number }[];
    readonly byTool: readonly { readonly key: string; readonly count: number }[];
    readonly recent: readonly { readonly goal: string; readonly toolName: string }[];
    readonly evidence: { readonly retentionDays: number; readonly caveat: string };
  };
}

export async function runIntents(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'status') return status(tail, env, home);
  if (subcommand === 'enable') return setMode(tail, 'starter-v1', env, home);
  if (subcommand === 'disable') return setMode(tail, 'off', env, home);
  if (subcommand === 'list') return list(tail, env, home);
  if (subcommand === 'purge') return purge(tail, env, home);
  usage();
  return EXIT.USAGE;
}

async function status(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const resolved = await resolveAnalyticsTarget('intents', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<IntentStatusResponse>(
      `${resolved.base}/intent-capture`,
      resolved.token,
    );
    if (args.json) printJsonOk(body.data);
    else {
      console.log(`Intent capture: ${body.data.mode === 'off' ? 'OFF' : 'ON (starter-v1)'}`);
      console.log(`Retention: ${body.data.retentionDays} days · Environment: ${resolved.env}`);
    }
    return EXIT.OK;
  } catch (error) {
    return failure(error, args.json, 'noodle intents status --org <org> --app <app>');
  }
}

async function setMode(
  rest: readonly string[],
  mode: 'off' | 'starter-v1',
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const resolved = await resolveAnalyticsTarget('intents', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<IntentStatusResponse>(
      `${resolved.base}/intent-capture`,
      resolved.token,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
    );
    if (args.json) printJsonOk(body.data);
    else if (mode === 'off') {
      console.log('Intent capture disabled. Existing retained insights were not deleted.');
    } else {
      console.log(`Intent capture enabled for ${resolved.org}/${resolved.app} · ${resolved.env}.`);
      console.log(
        'Client participation is optional; use `noodle intents list` to inspect coverage.',
      );
    }
    return EXIT.OK;
  } catch (error) {
    return failure(error, args.json, `noodle intents ${mode === 'off' ? 'disable' : 'enable'}`);
  }
}

async function list(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const flags = parseCommandFlags(rest, { values: { '--window': 'window' }, booleans: {} });
  const window = flags.window ?? '7d';
  if (!['24h', '7d', '14d'].includes(window)) {
    return printCliFailure(
      'intents',
      {
        code: 'invalid_window',
        message: '--window must be one of 24h, 7d, 14d',
        cause: 'Intent retention is fixed at 14 days for the preview.',
        fix: 'Choose a supported retention-bounded window.',
        next: 'noodle intents list --window 7d',
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('intents', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;
  try {
    const url = new URL(`${resolved.base}/intents`);
    url.searchParams.set('window', window);
    const body = await serviceJson<IntentInsightsResponse>(url.toString(), resolved.token);
    if (args.json) printJsonOk(body.data);
    else renderInsights(body.data, window);
    return EXIT.OK;
  } catch (error) {
    return failure(error, args.json, 'noodle intents list --window 7d');
  }
}

async function purge(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  if (!rest.includes('--yes')) {
    return printCliFailure(
      'intents',
      {
        code: 'confirmation_required',
        message: 'purge permanently deletes retained intent data and disables capture',
        cause: 'Intent purge is irreversible.',
        fix: 'Review the target, then pass --yes.',
        next: 'noodle intents purge --yes --org <org> --app <app>',
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('intents', args, env, home, {
    defaultToProduction: true,
  });
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<{ ok: true; data: { mode: 'off'; purged: number } }>(
      `${resolved.base}/intent-capture`,
      resolved.token,
      { method: 'DELETE' },
    );
    if (args.json) printJsonOk(body.data);
    else console.log(`Purged ${body.data.purged} intent events and disabled capture.`);
    return EXIT.OK;
  } catch (error) {
    return failure(error, args.json, 'noodle intents purge --yes');
  }
}

function renderInsights(data: IntentInsightsResponse['data'], window: string): void {
  const rate = (data.coverage.rate * 100).toFixed(1);
  console.log(
    `Intent insights · ${window} · ${data.mode === 'off' ? 'capture off' : 'capture on'}`,
  );
  console.log(
    `Coverage: ${data.coverage.captured}/${data.coverage.toolCalls} tool calls (${rate}%)`,
  );
  console.log(`Categories: ${formatCounts(data.byCategory) || 'none yet'}`);
  console.log(`Matches: ${formatCounts(data.byMatch) || 'none yet'}`);
  console.log(`Tools: ${formatCounts(data.byTool) || 'none yet'}`);
  console.log(`Evidence: ${data.evidence.caveat}`);
}

function formatCounts(values: readonly { key: string; count: number }[]): string {
  return values.map((value) => `${value.key} ${value.count}`).join(' · ');
}

function failure(error: unknown, json: boolean, next: string): number {
  return printCliFailure('intents', serviceFailure('intents', error, next), json);
}
