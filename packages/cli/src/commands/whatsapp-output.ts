import * as wire from '@noodle-borg/wire-contracts';
import { renderTable } from '../table.js';
import { stdoutTableOptions } from './resource-shared.js';

const CAPABILITY_STATUS: Readonly<Record<string, string>> = {
  native: 'Native',
  adapted: 'Adapted',
  handoff: 'Handoff',
  needs_setup: 'Needs setup',
  unavailable: 'Unavailable',
};
/** One compatibility line per business capability: status, code, failing requirement and next step. */
function capabilityLine(entry: {
  readonly capability: string;
  readonly status: string;
  readonly code?: string | undefined;
  readonly requirement?: string | undefined;
  readonly next?: string | undefined;
}): string {
  return `  ${CAPABILITY_STATUS[entry.status] ?? entry.status}: ${entry.capability}${entry.code ? ` (${entry.code})` : ''}${entry.requirement ? `; requires ${entry.requirement}` : ''}${entry.next ? `. Next: ${entry.next}` : ''}`;
}

/** Wire validation precedes human rendering; no provider bodies or protected addresses reach here. */
export function formatWhatsAppResult(result: unknown): string {
  const doctor = wire.WhatsAppReadinessClientResponseSchema.safeParse(result);
  if (doctor.success) {
    const { data } = doctor.data;
    return [
      data.ready ? 'WhatsApp is ready to enable.' : 'WhatsApp remains unavailable.',
      `Revision: ${data.revision}`,
      ...data.checks.map(
        (check) =>
          `${check.status === 'ready' ? 'Ready' : 'Unavailable'}: ${check.name}${check.code ? ` (${check.code})` : ''}`,
      ),
      ...(data.capabilities === undefined
        ? []
        : ['Capabilities:', ...data.capabilities.map(capabilityLine)]),
    ].join('\n');
  }
  const binding = wire.WhatsAppBindingClientResponseSchema.safeParse(result);
  if (binding.success) {
    const value = binding.data.data;
    if (!value)
      return 'No WhatsApp channel configured. Next: noodle channels whatsapp configure --help';
    return [
      `WhatsApp: ${value.state} (revision ${value.revision})`,
      `${value.tenant.org}/${value.tenant.app}/${value.tenant.env}`,
      `Binding: ${value.id}`,
      `Deployment: ${value.deploymentId}`,
      `Capabilities: ${value.capabilities.map((cap) => `${cap.kind}:${cap.name}`).join(', ') || 'none'}`,
      `Limits: ${value.limits.perMinute}/minute, ${value.limits.perHour}/hour, ${value.limits.perDay}/day per sender; ${value.limits.channelPerDay}/day per channel.`,
      `Daily inference ceiling: $${(value.limits.dailyMicroUsd / 1_000_000).toFixed(2)} USD.`,
      value.state === 'paused'
        ? 'Next: noodle channels whatsapp doctor'
        : 'Use events list for delivery receipts.',
    ].join('\n');
  }
  const usage = wire.WhatsAppUsageClientResponseSchema.safeParse(result);
  if (usage.success) {
    const v = usage.data.data;
    return [
      `Inference allowance for ${v.day} (UTC)`,
      `Settled ceiling: $${(v.spentMicroUsd / 1_000_000).toFixed(4)}`,
      `Reserved, including uncertain usage: $${(v.reservedMicroUsd / 1_000_000).toFixed(4)}`,
      `Limit: $${(v.dailyMicroUsd / 1_000_000).toFixed(2)}`,
      `Admitted: ${v.admittedToday}; new participants: ${v.newParticipantsToday}; resets ${new Date(v.resetAt).toISOString()}.`,
      `Pending: ${v.pending}${v.oldestPendingAt ? `; oldest ${new Date(v.oldestPendingAt).toISOString()}` : ''}; uncertain sends: ${v.unknownSends}.`,
      'Subscription, messaging, hosting and taxes are separate.',
    ].join('\n');
  }
  const events = wire.WhatsAppEventsClientResponseSchema.safeParse(result);
  if (events.success)
    return (
      renderTable(
        [
          { header: 'Event', get: (row) => row.id },
          { header: 'State', get: (row) => row.state },
          { header: 'Participant', get: (row) => row.participantId },
          { header: 'Code', get: (row) => row.code ?? '' },
        ],
        events.data.data,
        stdoutTableOptions(),
      ) + (events.data.next ? `\nNext: --after ${events.data.next}` : '')
    );
  const blocks = wire.WhatsAppBlocksClientResponseSchema.safeParse(result);
  if (blocks.success)
    return (
      (blocks.data.data
        .map(
          (item) =>
            `${item.participantId}: Borg ${item.local ? 'blocked' : 'unblocked'}; provider ${item.provider ? `${item.provider.desired}/${item.provider.state}` : 'not requested'}; ${item.until ? `until ${new Date(item.until).toISOString()}` : 'no local expiry'}`,
        )
        .join('\n') || 'No recorded blocks.') +
      (blocks.data.next ? `\nNext: --after ${blocks.data.next}` : '')
    );
  const webhook = wire.WhatsAppWebhookClientResponseSchema.safeParse(result);
  if (webhook.success)
    return [
      `Callback: ${webhook.data.data.url}`,
      `Destination matches: ${webhook.data.data.matches}`,
      `Authentication matches: ${webhook.data.data.authenticated}`,
    ].join('\n');
  const cooldown = wire.WhatsAppCooldownClientResponseSchema.safeParse(result);
  if (cooldown.success)
    return `${cooldown.data.data.participantId}: ${cooldown.data.data.until ? `cooldown until ${new Date(cooldown.data.data.until).toISOString()}` : 'no active cooldown'}`;
  return 'Change recorded. Use status, blocks list or events list to inspect the result.';
}
