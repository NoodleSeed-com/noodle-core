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
    const execute = vi.fn((_command: string, _args: string[]) => JSON.stringify(proof));
    expect(
      readManagedReaderFloorProof({
        serviceUrl: 'https://cloud.example',
        workloadAudience: 'release-audience',
        identityToken: 'secret-identity-token',
        execute,
      }),
    ).toEqual(proof);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toContain('Authorization: Bearer secret-identity-token');
    expect(JSON.stringify(proof)).not.toContain('secret-identity-token');
  });

  it('does not send an unauthenticated request when token preflight supplies no token', () => {
    const execute = vi.fn();
    expect(() =>
      readManagedReaderFloorProof({ workloadAudience: 'audience', identityToken: '', execute }),
    ).toThrow(/identity token is empty/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never includes bearer tokens or response bodies in a failed request diagnostic', () => {
    const execute = () => {
      throw new Error('curl --header Authorization: Bearer sensitive-token private-body');
    };
    expect(() =>
      readManagedReaderFloorProof({
        workloadAudience: 'audience',
        identityToken: 'sensitive-token',
        execute,
      }),
    ).toThrow(/^business-information reader-floor request failed$/);
  });

  it('does not expose a malformed response body in parsing errors', () => {
    expect(() =>
      readManagedReaderFloorProof({
        workloadAudience: 'audience',
        identityToken: 'sensitive-token',
        execute: () => 'sensitive-response-body',
      }),
    ).toThrow(/^business-information reader-floor response is invalid$/);
  });
});
