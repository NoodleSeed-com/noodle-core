import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { managedSpendDrift } from '@noodle-borg/assistant-gateway/portable';
import type { ConfigLocation } from '../config.js';
import { configDir } from '../config.js';
import { ServiceRequestError, serviceJson } from '../control-plane.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { runAssistantAppearance } from './assistant-appearance-ops.js';
import { runAssistantEmbed } from './assistant-embed-ops.js';
import { runAssistantSponsorship } from './assistant-sponsorship-ops.js';
import { runAssistantBudget, runAssistantEmbeds } from './assistant-surface-ops.js';
import { EXIT, printJsonOk } from './output.js';
import {
  parseTenantCommandArgs,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
} from './shared.js';

interface AssistantClientView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** Deployment active when the client was created; sessions follow the tenant's active deployment. */
  readonly createdAgainstDeploymentId?: string;
  readonly revokedAt?: string;
}

interface AssistantClientSecretView extends AssistantClientView {
  readonly clientSecret: string;
}

export async function runAssistant(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [noun, action, ...tail] = rest;
  if (noun === 'appearance') return runAssistantAppearance(rest.slice(1), env, home);
  if (noun === 'usage') return usage(rest.slice(1), env, home);
  if (noun === 'embed') return runAssistantEmbed(rest.slice(1), home, env);
  if (noun === 'embeds') return runAssistantEmbeds(rest.slice(1), env, home);
  if (noun === 'budget') return runAssistantBudget(rest.slice(1), env, home);
  if (noun === 'sponsorship') return runAssistantSponsorship(rest.slice(1), env, home);
  if (noun === 'doctor') return doctor(rest.slice(1), env, home);
  if (noun !== 'clients') {
    return printCommandUsageFailure(
      'assistant',
      'noodle assistant requires doctor, clients, embed, embeds, budget, sponsorship, appearance, or usage',
      'noodle assistant --help',
      rest.includes('--json'),
    );
  }
  if (action === 'create') return createClient(tail, env, home);
  if (action === 'list') return listClients(tail, env, home);
  if (action === 'rotate') return rotateClient(tail, env, home);
  if (action === 'revoke') return revokeClient(tail, env, home);
  return printCommandUsageFailure(
    'assistant',
    'noodle assistant clients requires create, list, rotate, or revoke',
    'noodle assistant clients --help',
    rest.includes('--json'),
  );
}

interface AssistantUsageResponse {
  readonly ok: boolean;
  readonly truncated?: boolean;
  readonly metrics: {
    readonly sessions: {
      readonly minted: number;
      readonly public: number;
      readonly authenticated: number;
    };
    readonly turns: {
      readonly attempted: number;
      readonly delivered: number;
      readonly failed: number;
      readonly refused: number;
    };
    readonly depth: {
      readonly p50: number;
      readonly p90: number;
      readonly max: number;
      readonly atLeast10: number;
      readonly atLeast20: number;
      readonly atLeast30: number;
      readonly atLeast40: number;
    };
    readonly engagement: {
      readonly modelRequests: number;
      readonly toolTurns: number;
      readonly interactionTurns: number;
    };
    readonly latency: { readonly p50Ms: number; readonly p95Ms: number };
    readonly tokens: {
      readonly prompt: number;
      readonly completion: number;
      readonly reasoning: number;
      readonly total: number;
    };
    readonly byModelSource: { readonly noodleManaged: number; readonly operator: number };
    readonly refusalsByCode?: Readonly<Record<string, number>>;
  };
}

async function usage(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const window = flagValue(rest, '--window') ?? '7d';
  if (!new Set(['24h', '7d', '30d']).has(window)) {
    return printCommandUsageFailure(
      'assistant',
      'assistant usage --window must be 24h, 7d, or 30d',
      'noodle assistant usage --window 7d',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AssistantUsageResponse>(
      `${resolved.base}/assistant/usage?window=${window}`,
      resolved.token,
    );
    if (args.json) printJsonOk(body);
    else {
      const { sessions, turns, depth, engagement, latency, tokens } = body.metrics;
      const refusals = Object.entries(body.metrics.refusalsByCode ?? {}).sort(
        ([, a], [, b]) => b - a,
      );
      console.log(`Assistant usage (${window})${body.truncated ? ' — partial window' : ''}`);
      console.log(
        `  ${sessions.minted.toLocaleString()} sessions · ${turns.attempted.toLocaleString()} turns (${turns.delivered.toLocaleString()} delivered, ${turns.failed.toLocaleString()} failed, ${turns.refused.toLocaleString()} refused)`,
      );
      console.log(
        `  Conversation depth: p50 ${depth.p50} · p90 ${depth.p90} · max ${depth.max} (${depth.atLeast20} reached 20, ${depth.atLeast30} reached 30, ${depth.atLeast40} reached 40)`,
      );
      console.log(
        `  Engagement: ${engagement.toolTurns.toLocaleString()} tool turns · ${engagement.interactionTurns.toLocaleString()} interaction turns · ${engagement.modelRequests.toLocaleString()} model requests`,
      );
      console.log(
        `  Model: ${tokens.total.toLocaleString()} tokens · p50 ${latency.p50Ms.toLocaleString()} ms · p95 ${latency.p95Ms.toLocaleString()} ms`,
      );
      // The ladder charges each turn what its rung's policy permits. If real turns cost more than
      // that, the enforcer is not enforcing and the sponsored ceiling is decorative — a bug worth
      // saying out loud rather than a budgeting note.
      // Only when the sponsor paid for every turn in the window. The token and turn totals below are
      // the surface's, not one source's, so on a surface that changed hands mid-window a handful of
      // expensive operator turns would raise a sponsored-spend alarm about turns nobody sponsored.
      // Silence is the honest reading there; the next whole window answers it.
      const drift =
        body.metrics.byModelSource.noodleManaged > 0 && body.metrics.byModelSource.operator === 0
          ? managedSpendDrift({
              deliveredTurns: turns.delivered,
              promptTokens: tokens.prompt,
              completionTokens: tokens.completion,
              reasoningTokens: tokens.reasoning,
            })
          : undefined;
      if (drift?.exceeded) {
        console.log(
          `  Warning: turns are averaging ${drift.observedPerTurn.toLocaleString()} billable tokens, above the ${drift.permittedPerTurn.toLocaleString()} a sponsored turn permits`,
        );
      }
      // Loudest first, and only when something was actually refused: a silent surface reads as a
      // quiet day, which is exactly how a throttled one used to look.
      if (refusals.length > 0) {
        console.log(
          `  Refused: ${refusals.map(([code, count]) => `${refusalCodeLabel(code)} ${count.toLocaleString()}`).join(' · ')}`,
        );
      }
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, `noodle assistant usage --window ${window}`),
      args.json,
    );
  }
}

interface AssistantDoctorResponse {
  readonly ok: boolean;
  readonly deploymentId?: string;
  readonly checks: Readonly<
    Record<
      string,
      {
        readonly ok: boolean;
        readonly skipped?: boolean;
        readonly probes?: readonly unknown[];
        readonly code?: string;
        readonly status?: number;
        readonly retryable?: boolean;
      }
    >
  >;
}

async function doctor(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const clientId = flagValue(rest, '--client-id') ?? env.NOODLE_ASSISTANT_CLIENT_ID;
  const clientSecret =
    env.NOODLE_ASSISTANT_CLIENT_SECRET ?? readPersistedClientSecret(home, clientId);
  const origin = flagValue(rest, '--origin') ?? env.PUBLIC_APP_ORIGIN;
  if (!clientId || !clientSecret || !origin) {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_doctor_config_missing',
        message:
          'Assistant doctor needs the backend client ID, client secret, and public app origin.',
        cause:
          'The diagnostic uses the same server-only credential and exact browser origin as the customer backend.',
        fix: 'Set NOODLE_ASSISTANT_CLIENT_ID, NOODLE_ASSISTANT_CLIENT_SECRET, and PUBLIC_APP_ORIGIN, or pass --client-id and --origin (the saved mode-0600 secret file is used automatically).',
        next: 'noodle assistant doctor --origin https://app.example.com',
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AssistantDoctorResponse>(
      `${resolved.base}/assistant/doctor`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          origin,
          ...(flagValue(rest, '--user-id') ? { userId: flagValue(rest, '--user-id') } : {}),
        }),
      },
    );
    if (args.json) printJsonOk(body);
    else {
      console.log(body.ok ? 'Assistant boundary is ready.' : 'Assistant boundary needs attention.');
      for (const [name, check] of Object.entries(body.checks)) {
        const detail =
          check.code === undefined
            ? ''
            : ` — ${[
                check.code,
                ...(check.status === undefined ? [] : [`HTTP ${check.status}`]),
                ...(check.retryable === undefined
                  ? []
                  : [check.retryable ? 'retryable' : 'not retryable']),
              ].join(', ')}`;
        console.log(`  ${check.ok ? 'PASS' : check.skipped ? 'SKIP' : 'FAIL'}  ${name}${detail}`);
      }
      if (!body.ok) {
        console.log('Fix failed checks, then rerun noodle assistant doctor.');
      }
    }
    return body.ok ? EXIT.OK : 1;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant doctor'),
      args.json,
    );
  }
}

function readPersistedClientSecret(
  home: ConfigLocation,
  clientId: string | undefined,
): string | undefined {
  if (!clientId) return undefined;
  const path = join(configDir(home), 'assistant-clients', `${clientId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      readonly clientId?: unknown;
      readonly clientSecret?: unknown;
    };
    return value.clientId === clientId && typeof value.clientSecret === 'string'
      ? value.clientSecret
      : undefined;
  } catch {
    return undefined;
  }
}

async function createClient(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const name = flagValue(rest, '--name') ?? 'web';
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AssistantClientSecretView>(
      `${resolved.base}/assistant/clients`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );
    const secretPath = persistClientSecret(home, body.id, body.clientSecret);
    const output = {
      id: body.id,
      name: body.name,
      createdAt: body.createdAt,
      secretFile: secretPath,
      serviceUrl: resolved.serviceUrl,
    };
    if (args.json) printJsonOk(output);
    else {
      console.log(`Assistant client created: ${body.id}`);
      console.log(`Credentials saved with mode 0600: ${secretPath}`);
      console.log(
        'Load that file only from your authenticated backend; never ship it to the browser.',
      );
      console.log('');
      console.log('Wire it into your web application:');
      console.log('  Backend environment (from your secret manager, never the browser):');
      console.log(`    NOODLE_SERVICE_URL=${resolved.serviceUrl}`);
      console.log(`    NOODLE_ASSISTANT_CLIENT_ID=${body.id}`);
      console.log(`    NOODLE_ASSISTANT_CLIENT_SECRET=<clientSecret from ${secretPath}>`);
      console.log('  Authenticated backend route (session exchange):');
      console.log("    import { createAssistantSession } from '@noodleseed/assistant/server';");
      console.log(
        '    const session = await createAssistantSession({ serviceUrl: process.env.NOODLE_SERVICE_URL!,',
      );
      console.log(
        '      clientId: process.env.NOODLE_ASSISTANT_CLIENT_ID!, clientSecret: process.env.NOODLE_ASSISTANT_CLIENT_SECRET!,',
      );
      console.log(
        '      origin: process.env.PUBLIC_APP_ORIGIN!, user: { id: user.id } }); // then: return Response.json(session)',
      );
      console.log('  Client-only mount (React):');
      console.log('    <NoodleAssistant sessionEndpoint="/api/assistant/session" />');
      console.log(
        '  Full guide: https://docs.noodleseed.dev/docs/guides/embedded-assistant (serviceUrl is the control plane, not your MCP deployment URL).',
      );
    }
    return EXIT.OK;
  } catch (error) {
    if (
      error instanceof ServiceRequestError &&
      error.status === 409 &&
      error.message === 'deployment has no embedded assistant'
    ) {
      return printCliFailure(
        'assistant',
        {
          code: 'assistant_deployment_required',
          message: 'No active assistant-enabled deployment exists for this target.',
          cause:
            'Assistant clients are deployment-bound and can only be created after an assistant configuration is active.',
          fix: 'Deploy an assistant-enabled server to this org/app/env, then create the client.',
          next: 'noodle deploy',
          ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
          exitCode: 1,
        },
        args.json,
      );
    }
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant clients create --name web'),
      args.json,
    );
  }
}

async function listClients(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<{
      readonly ok: true;
      readonly clients: readonly AssistantClientView[];
    }>(`${resolved.base}/assistant/clients`, resolved.token);
    if (args.json) printJsonOk({ clients: body.clients });
    else if (body.clients.length === 0) console.log('No assistant clients.');
    else {
      for (const client of body.clients) {
        const createdAgainst = client.createdAgainstDeploymentId
          ? `  created-against ${client.createdAgainstDeploymentId}`
          : '';
        console.log(
          `${client.id}  ${client.name}${createdAgainst}${client.revokedAt ? '  revoked' : ''}`,
        );
      }
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant clients list'),
      args.json,
    );
  }
}

async function rotateClient(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const id = positionalId(rest);
  if (!id) {
    return printCommandUsageFailure(
      'assistant',
      'noodle assistant clients rotate requires a client id',
      'noodle assistant clients rotate <client-id> --json',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    const body = await serviceJson<AssistantClientSecretView>(
      `${resolved.base}/assistant/clients/${encodeURIComponent(id)}/rotate`,
      resolved.token,
      { method: 'POST' },
    );
    const secretPath = persistClientSecret(home, body.id, body.clientSecret);
    if (args.json) printJsonOk({ id: body.id, secretFile: secretPath });
    else console.log(`Assistant client rotated. New credentials saved: ${secretPath}`);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, `noodle assistant clients rotate ${id}`),
      args.json,
    );
  }
}

async function revokeClient(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const id = positionalId(rest);
  if (!id) {
    return printCommandUsageFailure(
      'assistant',
      'noodle assistant clients revoke requires a client id',
      'noodle assistant clients revoke <client-id> --json',
      args.json,
    );
  }
  const resolved = await resolveAnalyticsTarget('assistant', args, env, home);
  if (typeof resolved === 'number') return resolved;
  try {
    await serviceJson<void>(
      `${resolved.base}/assistant/clients/${encodeURIComponent(id)}`,
      resolved.token,
      { method: 'DELETE' },
    );
    if (args.json) printJsonOk({ id, revoked: true });
    else console.log(`Assistant client revoked: ${id}`);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'assistant',
      serviceFailure('assistant', error, 'noodle assistant clients list'),
      args.json,
    );
  }
}

function persistClientSecret(home: ConfigLocation, id: string, clientSecret: string): string {
  const directory = join(configDir(home), 'assistant-clients');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ clientId: id, clientSecret }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

/**
 * One refusal code, safe to print.
 *
 * The codes arrive as JSON object keys from the service and go straight to a terminal. A code is an
 * identifier, so only identifier characters survive: anything else is either a bug upstream or an
 * escape sequence wearing a code's clothes, and neither should be able to move a operator's cursor.
 */
function refusalCodeLabel(code: string): string {
  return code.replace(/[^\w.:-]/g, '').slice(0, 64) || 'unknown';
}

function flagValue(rest: readonly string[], flag: string): string | undefined {
  const index = rest.indexOf(flag);
  return index >= 0 ? rest[index + 1] : undefined;
}

function positionalId(rest: readonly string[]): string | undefined {
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value) continue;
    if (value.startsWith('--')) {
      if (!['--json'].includes(value)) index += 1;
      continue;
    }
    return value;
  }
  return undefined;
}
