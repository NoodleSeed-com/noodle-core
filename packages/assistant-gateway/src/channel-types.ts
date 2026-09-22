import { createHash, createHmac } from 'node:crypto';
import type { ChannelRow, ChannelTransaction } from './channel-store.js';
import type { TenantRef } from './tenant-ref.js';

export const CHANNEL_DAY_MS = 86_400_000;
export const CHANNEL_RETENTION_MS = 7 * CHANNEL_DAY_MS;
export const CHANNEL_REGISTRY = 'assistant-channels';
export const CHANNEL_DEFAULT_LIMITS = Object.freeze({
  perMinute: 10,
  perHour: 60,
  perDay: 200,
  channelPerDay: 1000,
  newParticipantsPerDay: 200,
  concurrent: 5,
  pendingPerParticipant: 3,
  pending: 100,
  textCharacters: 4000,
  dailyMicroUsd: 20_000_000,
});
export type ChannelLimits = { -readonly [K in keyof typeof CHANNEL_DEFAULT_LIMITS]: number };
export type ChannelLimitsInput = { [K in keyof ChannelLimits]?: number | undefined };
/** `360dialog` relays the Cloud API with a per-binding callback secret; `meta` is the Cloud API itself. */
export type ChannelProvider = '360dialog' | 'meta';
export type ChannelCapability = { readonly kind: 'tool' | 'knowledge'; readonly name: string };
export interface ChannelBinding {
  readonly id: string;
  readonly tenant: TenantRef;
  readonly provider: ChannelProvider;
  readonly phoneNumberId: string;
  /** The WhatsApp Business Account that owns the number; present only for `meta`. */
  readonly wabaId?: string | undefined;
  /** Tenant secret name of the provider credential: 360dialog key or Meta business token. */
  readonly apiKeySecret: string;
  /** Tenant secret name of the per-binding callback secret; present only for `360dialog`. */
  readonly webhookSecret?: string | undefined;
  readonly deploymentId: string;
  readonly capabilities: readonly ChannelCapability[];
  readonly supportEmail: string;
  readonly revision: number;
  readonly generation: number;
  readonly state: 'paused' | 'enabled' | 'disconnected';
  /** Private, encrypted indexing seed. Never projected to an operator response or model. */
  readonly indexKey: string;
  readonly credentialDigest?: string;
  readonly limits: ChannelLimits;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly actor: string;
  readonly readyRevision?: number | undefined;
  readonly readyAt?: number | undefined;
}
export type ChannelConfigure = Pick<
  ChannelBinding,
  | 'tenant'
  | 'phoneNumberId'
  | 'wabaId'
  | 'apiKeySecret'
  | 'webhookSecret'
  | 'deploymentId'
  | 'capabilities'
  | 'supportEmail'
> & {
  /** Defaults to `360dialog`. */
  readonly provider?: ChannelProvider | undefined;
  readonly limits?: ChannelLimitsInput | undefined;
};
export interface ChannelAddress {
  readonly kind: 'phone' | 'opaque';
  readonly value: string;
}
export interface ChannelHistory {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: number;
}
export interface ChannelParticipant {
  readonly id: string;
  readonly address: ChannelAddress;
  readonly lastInboundAt: number;
  readonly history: readonly ChannelHistory[];
  readonly strikes: readonly number[];
  readonly deploymentId?: string;
  readonly modelToolUses?: readonly string[];
  readonly cooldownUntil?: number;
}
export type ChannelEventState =
  | 'queued'
  | 'running'
  | 'reply'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'read'
  | 'refused'
  | 'expired'
  | 'failed'
  | 'cancelled'
  | 'unknown';
/** A native reply button: an opaque server-bound id and the label the participant sees. */
export interface ChannelReplyButton {
  readonly id: string;
  readonly title: string;
}
export interface ChannelEvent {
  readonly id: string;
  readonly participantId: string;
  readonly providerId: string;
  readonly providerMessageId?: string;
  readonly text?: string;
  /** The button the participant tapped, in place of text. */
  readonly button?: ChannelReplyButton;
  readonly reply?: string;
  /** What history keeps of the reply when it must differ from the sent text; replaces `reply` once dispatched. */
  readonly replyTranscript?: string;
  /** Native reply buttons offered with the reply; content-free, dropped once dispatch is attempted. */
  readonly buttons?: readonly ChannelReplyButton[];
  readonly eventAt: number;
  readonly receivedAt: number;
  readonly generation: number;
  readonly deploymentId: string;
  readonly state: ChannelEventState;
  readonly attempts: number;
  readonly lease?: string | undefined;
  readonly leaseUntil?: number | undefined;
  readonly turnDeadline?: number;
  readonly code?: string;
}
export interface ChannelInbound {
  readonly providerId: string;
  readonly address: ChannelAddress;
  readonly eventAt: number;
  readonly text?: string;
  readonly button?: ChannelReplyButton;
}
export class ChannelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChannelError';
  }
}
export function channelDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function channelTenantKey(tenant: TenantRef): string {
  return `tenant:${channelDigest(JSON.stringify([tenant.org, tenant.app, tenant.env]))}`;
}
export function channelParticipantId(binding: ChannelBinding, address: ChannelAddress): string {
  return `p_${createHmac('sha256', Buffer.from(binding.indexKey, 'base64'))
    .update(JSON.stringify([binding.id, address.kind, address.value]))
    .digest('hex')}`;
}
export function sameChannelTenant(left: TenantRef, right: TenantRef): boolean {
  return left.org === right.org && left.app === right.app && left.env === right.env;
}
export function channelLimits(input: ChannelLimitsInput = {}): ChannelLimits {
  const limits: ChannelLimits = { ...CHANNEL_DEFAULT_LIMITS };
  for (const key of Object.keys(input)) {
    if (!(key in limits)) throw new ChannelError('limits_invalid');
    const name = key as keyof ChannelLimits;
    const value = input[name];
    if (
      value === undefined ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > CHANNEL_DEFAULT_LIMITS[name]
    )
      throw new ChannelError('limits_invalid');
    limits[name] = value;
  }
  return limits;
}
/** Row values are private, encrypted implementation records, never unchecked API payloads. */
export async function channelValue<T>(
  tx: ChannelTransaction,
  scope: string,
  id: string,
): Promise<T | undefined> {
  return (await tx.get(scope, id))?.value as T | undefined;
}
export function channelRow(
  id: string,
  kind: ChannelRow['kind'],
  value: unknown,
  now: number,
  options: { state?: string; expiresAt?: number } = {},
): ChannelRow {
  return { id, kind, value, updatedAt: now, ...options };
}
export async function writeChannelEvent(
  tx: ChannelTransaction,
  scope: string,
  event: ChannelEvent,
  now: number,
): Promise<void> {
  await tx.put(
    scope,
    channelRow(event.id, 'event', event, now, {
      state: event.state,
      expiresAt: event.receivedAt + CHANNEL_RETENTION_MS,
    }),
  );
}
export function publicChannelBinding(binding: ChannelBinding) {
  const { indexKey: _privateIndexKey, credentialDigest: _credentialDigest, ...visible } = binding;
  return visible;
}
