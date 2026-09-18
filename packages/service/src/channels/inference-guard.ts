import { randomUUID } from 'node:crypto';
import type {
  AssistantInferenceCostBound,
  ResolvedAssistantModel,
} from '@noodle-borg/assistant-gateway/model-runtime';
import {
  billedOutputTokens,
  type ChannelCoordinator,
  ChannelError,
} from '@noodle-borg/assistant-gateway/portable';

export function verifiedInferenceBound(
  binding: ResolvedAssistantModel,
  now = Date.now(),
): AssistantInferenceCostBound {
  const bound = binding.inferenceCost;
  if (
    !bound ||
    !bound.version ||
    !Number.isFinite(Date.parse(bound.validUntil)) ||
    Date.parse(bound.validUntil) <= now
  )
    throw new ChannelError('spend_bound_unverified');
  for (const number of [
    bound.maxInputTokens,
    bound.maxBilledOutputTokens,
    bound.inputMicroUsdPerMillionTokens,
    bound.outputMicroUsdPerMillionTokens,
  ])
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new ChannelError('spend_bound_unverified');
  if (!Number.isSafeInteger(quote(bound, bound.maxInputTokens, bound.maxBilledOutputTokens)))
    throw new ChannelError('spend_bound_unverified');
  return bound;
}
function quote(bound: AssistantInferenceCostBound, input: number, output: number): number {
  // Integer arithmetic retains fractional micro-dollar prices without floating-point under-reservation.
  return Number(
    (BigInt(input) * BigInt(bound.inputMicroUsdPerMillionTokens) +
      BigInt(output) * BigInt(bound.outputMicroUsdPerMillionTokens) +
      999_999n) /
      1_000_000n,
  );
}
export function withChannelInferenceGuard(
  binding: ResolvedAssistantModel,
  channels: ChannelCoordinator,
  id: string,
  turn: string,
  beforeRequest: () => Promise<void>,
): ResolvedAssistantModel {
  verifiedInferenceBound(binding, channels.now());
  return {
    ...binding,
    inferenceGuard: {
      async reserve() {
        await beforeRequest();
        const bound = verifiedInferenceBound(binding, channels.now());
        const attempt = `${turn}:${randomUUID()}`;
        await channels.reserveSpend(
          id,
          attempt,
          quote(bound, bound.maxInputTokens, bound.maxBilledOutputTokens),
        );
        return {
          async cancelBeforeDispatch() {
            await channels.settleSpend(id, attempt, 0);
          },
          async settle(usage) {
            const output = billedOutputTokens(usage);
            const actual = quote(bound, usage.promptTokens, output);
            await channels.settleSpend(id, attempt, actual);
          },
        };
      },
    },
  };
}
