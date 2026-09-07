import { describe, expect, it, vi } from 'vitest';
import {
  parseManagedReaderFloorProof,
  readManagedReaderFloorProof,
} from '../../../scripts/lib/system-release-reader-floor.mjs';

const proof = {
  ok: true,
  inventory: { acceptedSchemaIdentities: 2, digest: `sha256:${'a'.repeat(64)}` },
  readerTargets: 3,
};

describe('System Release business-information reader floor', () => {
  it('accepts only a complete bounded proof', () => {
    expect(parseManagedReaderFloorProof(proof)).toEqual(proof);
    for (const invalid of [
      { ...proof, ok: false },
      { ...proof, inventory: { ...proof.inventory, acceptedSchemaIdentities: -1 } },
      { ...proof, inventory: { ...proof.inventory, digest: 'sha256:mutable' } },
      { ...proof, readerTargets: 0 },
    ]) {
      expect(() => parseManagedReaderFloorProof(invalid)).toThrow(/proof is invalid/);
    }
  });

  it('uses a workload identity token without returning it in the proof', () => {
    const execute = vi.fn((command: string) =>
      command === 'gcloud' ? 'secret-identity-token\n' : JSON.stringify(proof),
    );
    expect(
      readManagedReaderFloorProof({
        serviceUrl: 'https://cloud.example',
        workloadAudience: 'release-audience',
        execute,
      }),
    ).toEqual(proof);
    expect(execute).toHaveBeenNthCalledWith(1, 'gcloud', [
      'auth',
      'print-identity-token',
      '--audiences',
      'release-audience',
    ]);
    expect(execute.mock.calls[1]?.[1]).toContain('Authorization: Bearer secret-identity-token');
    expect(JSON.stringify(proof)).not.toContain('secret-identity-token');
  });
});
