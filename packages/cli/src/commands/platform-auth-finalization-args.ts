export interface PlatformAuthFinalizationEvidence {
  readonly rollbackRehearsalChecksum: string;
  readonly stagingWorkosOnlySmokeChecksum: string;
}

export function hasPlatformAuthFinalizationEvidenceFlags(
  values: ReadonlyMap<string, string>,
): boolean {
  return (
    values.has('--rollback-rehearsal-checksum') ||
    values.has('--staging-workos-only-smoke-checksum')
  );
}

export function parsePlatformAuthFinalizationEvidence(
  values: ReadonlyMap<string, string>,
):
  | { readonly ok: true; readonly value: PlatformAuthFinalizationEvidence }
  | { readonly ok: false; readonly message: string } {
  const rollbackRehearsalChecksum = values.get('--rollback-rehearsal-checksum');
  if (rollbackRehearsalChecksum === undefined || !validChecksum(rollbackRehearsalChecksum)) {
    return {
      ok: false,
      message: '--rollback-rehearsal-checksum must be 64 lowercase hexadecimal characters',
    };
  }
  const stagingWorkosOnlySmokeChecksum = values.get('--staging-workos-only-smoke-checksum');
  if (
    stagingWorkosOnlySmokeChecksum === undefined ||
    !validChecksum(stagingWorkosOnlySmokeChecksum)
  ) {
    return {
      ok: false,
      message: '--staging-workos-only-smoke-checksum must be 64 lowercase hexadecimal characters',
    };
  }
  return {
    ok: true,
    value: { rollbackRehearsalChecksum, stagingWorkosOnlySmokeChecksum },
  };
}

function validChecksum(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
