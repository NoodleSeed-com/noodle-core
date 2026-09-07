/** Aggregate only existing terminal evidence; no payload, reference or actor attribution leaves this port. */
export interface OperationHistoryPreviewInput {
  readonly asOf: number;
  readonly paidPeriodEnd: number;
  readonly currentMaximumDays: number;
  readonly scenarios: readonly { readonly id: string; readonly maximumDays: number }[];
}
export interface OperationHistoryPreviewCounts {
  readonly currentlyAccessibleCount: number;
  readonly physicallyExpiresByPeriodEndCount: number;
  readonly scenarios: readonly {
    readonly id: string;
    readonly additionallyHiddenAtPeriodEndCount: number;
  }[];
}

export function summarizeOperationHistory(
  records: Iterable<{
    readonly outcome: string;
    readonly startedAt: number;
    readonly completedAt?: number;
    readonly executionDeadline: number;
    readonly historyExpiresAt: number;
  }>,
  input: OperationHistoryPreviewInput,
): OperationHistoryPreviewCounts {
  const result = {
    currentlyAccessibleCount: 0,
    physicallyExpiresByPeriodEndCount: 0,
    scenarios: input.scenarios.map(({ id }) => ({ id, additionallyHiddenAtPeriodEndCount: 0 })),
  };
  for (const record of records) {
    const dispatching = record.outcome === 'dispatching';
    if (dispatching && record.executionDeadline > input.asOf) continue;
    const completedAt = dispatching
      ? record.executionDeadline
      : (record.completedAt ?? record.startedAt);
    const expiresAt = dispatching
      ? record.executionDeadline + record.historyExpiresAt - record.startedAt
      : record.historyExpiresAt;
    if (
      completedAt > input.asOf ||
      expiresAt <= input.asOf ||
      completedAt < input.asOf - input.currentMaximumDays * 86_400_000
    )
      continue;
    result.currentlyAccessibleCount++;
    if (expiresAt <= input.paidPeriodEnd) result.physicallyExpiresByPeriodEndCount++;
    else if (completedAt >= input.paidPeriodEnd - input.currentMaximumDays * 86_400_000) {
      input.scenarios.forEach((scenario, index) => {
        const count = result.scenarios[index];
        if (count && completedAt < input.paidPeriodEnd - scenario.maximumDays * 86_400_000)
          count.additionallyHiddenAtPeriodEndCount++;
      });
    }
  }
  return result;
}
