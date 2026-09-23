import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as wire from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { serviceJson } from '../control-plane.js';
import { resolveAnalyticsTarget } from './analytics-ops.js';
import { printJsonOk } from './output.js';
import {
  parseCommandFlags,
  parseTenantCommandArgs,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
} from './shared.js';
import { formatWhatsAppResult } from './whatsapp-output.js';

const LIMIT_FLAGS = {
  '--per-minute': 'perMinute',
  '--per-hour': 'perHour',
  '--per-day': 'perDay',
  '--channel-per-day': 'channelPerDay',
  '--new-participants-per-day': 'newParticipantsPerDay',
  '--concurrent': 'concurrent',
  '--pending-per-participant': 'pendingPerParticipant',
  '--pending': 'pending',
  '--text-characters': 'textCharacters',
  '--daily-micro-usd': 'dailyMicroUsd',
} as const;
const VALUES = {
  '--scope': 'scope',
  '--service': 'service',
  '--auth-token': 'authToken',
  '--org': 'org',
  '--app': 'app',
  '--env': 'env',
  '--provider': 'provider',
  '--phone-number-id': 'phoneNumberId',
  '--waba-id': 'wabaId',
  '--api-key-secret': 'apiKeySecret',
  '--webhook-secret': 'webhookSecret',
  '--capabilities': 'capabilities',
  '--support-email': 'supportEmail',
  '--expected-revision': 'expectedRevision',
  '--idempotency-key': 'idempotencyKey',
  '--participant-id': 'participantId',
  '--event-id': 'eventId',
  '--until': 'until',
  '--after': 'after',
  ...LIMIT_FLAGS,
} as const;
const parse = (rest: readonly string[]) =>
  parseCommandFlags(rest, {
    values: VALUES,
    booleans: { '--json': 'json', '--indefinite': 'indefinite', '--phone-stdin': 'phoneStdin' },
  });
interface Operation {
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly response: { parse(value: unknown): unknown };
}
export function whatsappOperation(rest: readonly string[], protectedPhone?: string): Operation {
  const flags = parse(rest);
  if (flags.parseError) throw new Error(flags.parseError);
  const [noun, action, extra] = flags.positional;
  if (extra) throw new Error('Unexpected positional argument');
  const revision = () => {
    if (flags.expectedRevision === undefined || !/^\d+$/.test(flags.expectedRevision))
      throw new Error('--expected-revision is required; read status first');
    return Number(flags.expectedRevision);
  };
  const limits = () =>
    wire.WhatsAppLimitsSchema.partial().parse(
      Object.fromEntries(
        Object.values(LIMIT_FLAGS).flatMap((name) =>
          flags[name] === undefined ? [] : [[name, Number(flags[name])]],
        ),
      ),
    );
  const participant = () => {
    if (!flags.participantId || !/^p_[a-f0-9]{64}$/.test(flags.participantId))
      throw new Error('--participant-id is required; use events list to find it');
    return flags.participantId;
  };
  const get = (path: string, response: Operation['response']): Operation => ({
    path,
    method: 'GET',
    response,
  });
  if (noun === 'status' && !action) return get('', wire.WhatsAppBindingClientResponseSchema);
  if (noun === 'configure' && !action) {
    const { provider, ...body } = wire.WhatsAppConfigureRequestSchema.parse({
      expectedRevision: revision(),
      provider: flags.provider,
      phoneNumberId: flags.phoneNumberId,
      wabaId: flags.wabaId,
      apiKeySecret: flags.apiKeySecret,
      webhookSecret: flags.webhookSecret,
      supportEmail: flags.supportEmail,
      capabilities: flags.capabilities?.split(',').map((value) => {
        const [kind, name, third] = value.split(':');
        if (third) throw new Error('Invalid capability');
        return { kind, name };
      }),
      limits: limits(),
    });
    return {
      path: '',
      method: 'PUT',
      // An unselected provider stays implicit so services that predate the choice accept the body.
      body: flags.provider === undefined ? body : { ...body, provider },
      response: wire.WhatsAppBindingClientResponseSchema,
    };
  }
  if (noun === 'doctor' && !action)
    return {
      path: '/readiness',
      method: 'POST',
      body: {},
      response: wire.WhatsAppReadinessClientResponseSchema,
    };
  if (['enable', 'pause', 'disconnect'].includes(noun ?? '') && !action)
    return {
      path: noun === 'disconnect' ? '' : '/state',
      method: noun === 'disconnect' ? 'DELETE' : 'PATCH',
      body: {
        expectedRevision: revision(),
        ...(noun === 'disconnect' ? {} : { state: noun === 'enable' ? 'enabled' : 'paused' }),
      },
      response: wire.WhatsAppBindingClientResponseSchema,
    };
  if (noun === 'limits' && action === 'get')
    return get('/limits', wire.WhatsAppBindingClientResponseSchema);
  if (noun === 'limits' && action === 'set') {
    const selected = limits();
    if (!Object.keys(selected).length) throw new Error('Provide at least one limit');
    return {
      path: '/limits',
      method: 'PATCH',
      body: { expectedRevision: revision(), limits: selected },
      response: wire.WhatsAppBindingClientResponseSchema,
    };
  }
  if (noun === 'usage' && !action) return get('/usage', wire.WhatsAppUsageClientResponseSchema);
  if (noun === 'webhook' && action === 'inspect')
    return get('/webhook', wire.WhatsAppWebhookClientResponseSchema);
  if (noun === 'webhook' && action === 'configure')
    return {
      path: '/webhook',
      method: 'POST',
      body: { expectedRevision: revision() },
      response: wire.WhatsAppWebhookClientResponseSchema,
    };
  if (noun === 'blocks' && action === 'list')
    return get(
      `/blocks${flags.after ? `?after=${encodeURIComponent(flags.after)}` : ''}`,
      wire.WhatsAppBlocksClientResponseSchema,
    );
  if (noun === 'block' && !action) {
    if ((!flags.until && !flags.indefinite) || (flags.until && flags.indefinite))
      throw new Error('Choose --until <ISO timestamp> or --indefinite');
    const body = wire.WhatsAppBlockRequestSchema.parse({
      ...(flags.phoneStdin ? { phone: protectedPhone } : { participantId: participant() }),
      ...(flags.scope ? { scope: flags.scope } : {}),
      until: flags.indefinite ? null : Date.parse(flags.until!),
    });
    return {
      path: '/blocks',
      method: 'POST',
      body,
      response: wire.WhatsAppMutationClientResponseSchema,
    };
  }
  if (noun === 'unblock' && !action)
    return {
      path: `/blocks/${participant()}`,
      method: 'DELETE',
      body: wire.WhatsAppUnblockRequestSchema.parse({
        ...(flags.phoneStdin ? { phone: protectedPhone } : {}),
        ...(flags.scope ? { scope: flags.scope } : {}),
      }),
      response: wire.WhatsAppMutationClientResponseSchema,
    };
  if (noun === 'cooldown' && ['inspect', 'clear'].includes(action ?? ''))
    return {
      path: `/cooldowns/${participant()}`,
      method: action === 'clear' ? 'DELETE' : 'GET',
      ...(action === 'clear' ? { body: {} } : {}),
      response: wire.WhatsAppCooldownClientResponseSchema,
    };
  if (noun === 'events' && action === 'list')
    return get(
      `/events${flags.after ? `?after=${encodeURIComponent(flags.after)}` : ''}`,
      wire.WhatsAppEventsClientResponseSchema,
    );
  if (noun === 'events' && ['inspect', 'reconcile'].includes(action ?? '')) {
    if (!flags.eventId || !/^e_[0-9_]+$/.test(flags.eventId))
      throw new Error('--event-id is required');
    return {
      path: `/events/${flags.eventId}${action === 'reconcile' ? '/reconcile' : ''}`,
      method: action === 'reconcile' ? 'POST' : 'GET',
      ...(action === 'reconcile' ? { body: {} } : {}),
      response: wire.WhatsAppEventsClientResponseSchema,
    };
  }
  throw new Error('Choose a documented WhatsApp operation; see noodle channels whatsapp --help');
}
export async function runChannels(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const json = rest.includes('--json');
  if (rest[0] !== 'whatsapp')
    return printCommandUsageFailure(
      'channels',
      'Choose whatsapp',
      'noodle channels whatsapp --help',
      json,
    );
  let operation: Operation;
  try {
    let protectedPhone: string | undefined;
    if (rest.includes('--phone-stdin')) {
      if (
        !['block', 'unblock'].includes(rest[1] ?? '') ||
        (rest[1] === 'block' && rest.includes('--participant-id')) ||
        process.stdin.isTTY
      )
        throw new Error(
          '--phone-stdin requires piped E.164 input for block, or unblock with its participant ID',
        );
      let value = '';
      for await (const chunk of process.stdin) {
        value += String(chunk);
        if (value.length > 32) throw new Error('Phone input is too long');
      }
      protectedPhone = value.trim();
    }
    operation = whatsappOperation(rest.slice(1), protectedPhone);
  } catch (error) {
    return printCommandUsageFailure(
      'channels',
      error instanceof Error ? error.message : 'Invalid options',
      'noodle channels whatsapp --help',
      json,
    );
  }
  const resolved = await resolveAnalyticsTarget(
    'channels',
    parseTenantCommandArgs(rest.slice(1)),
    env,
    home,
  );
  if (typeof resolved === 'number') return resolved;
  try {
    const info = wire.serviceInfoClientResponseSchema.parse(
      await serviceJson(`${resolved.serviceUrl}/v1/service/info`, resolved.token, {}, fetcher),
    );
    if (info.features?.whatsapp !== 1)
      return printCliFailure(
        'channels',
        {
          code: 'unsupported_service',
          cause: 'The selected service lacks the WhatsApp API capability.',
          message: 'This service does not advertise WhatsApp channels.',
          fix: 'Upgrade the service and enable durable channel storage.',
          next: 'noodle channels whatsapp status',
          exitCode: 2,
        },
        json,
      );
    const result = operation.response.parse(
      await serviceJson(
        `${resolved.base}/channels/whatsapp${operation.path}`,
        resolved.token,
        {
          method: operation.method,
          ...(operation.method !== 'GET'
            ? {
                headers: { 'idempotency-key': parse(rest.slice(1)).idempotencyKey ?? randomUUID() },
              }
            : {}),
          ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
        },
        fetcher,
        { timeoutMs: 60_000 },
      ),
    );
    if (json) printJsonOk({ result });
    else console.log(formatWhatsAppResult(result));
    if (
      rest[1] === 'doctor' &&
      wire.WhatsAppReadinessClientResponseSchema.parse(result).data.ready === false
    )
      return 2;
    return 0;
  } catch (error) {
    return printCliFailure(
      'channels',
      serviceFailure('channels', error, 'noodle channels whatsapp doctor'),
      json,
    );
  }
}
