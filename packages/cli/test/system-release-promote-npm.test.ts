import { describe, expect, it, vi } from 'vitest';
import { reconcileNpmPackage } from '../../../scripts/lib/system-release-npm-reconciliation.mjs';

const entry = {
  package: '@noodleseed/one',
  version: '0.160.0',
  integrity: 'sha512-expected',
  tarball: '@noodleseed-one.tgz',
};

function missingState() {
  return { version: null, integrity: null, latest: null };
}

function exactState(integrity = entry.integrity) {
  return { version: entry.version, integrity, latest: entry.version };
}

function npmPublishError(
  version: string,
  detail = 'Cannot publish over previously staged version',
) {
  return Object.assign(new Error('npm publish failed'), {
    stderr: [
      'npm error code E409',
      `npm error 409 Conflict - PUT https://registry.npmjs.org/@noodleseed%2fone - ${detail} "${version}".`,
    ].join('\n'),
  });
}

describe('system release npm reconciliation', () => {
  it('continues bounded convergence after npm reports the expected version is already staged', async () => {
    const npmState = vi
      .fn()
      .mockResolvedValueOnce(missingState())
      .mockResolvedValueOnce(missingState())
      .mockResolvedValueOnce(exactState());
    const publish = vi.fn().mockRejectedValue(npmPublishError(entry.version));
    const wait = vi.fn();

    await expect(reconcileNpmPackage(entry, { npmState, publish, wait })).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it.each([
    ['a conflict for a different version', npmPublishError('0.159.0')],
    ['a generic registry conflict', npmPublishError(entry.version, 'version already exists')],
    ['an unrelated publish failure', new Error('authentication failed')],
  ])('fails closed for %s', async (_name, error) => {
    const adapter = {
      npmState: vi.fn().mockResolvedValue(missingState()),
      publish: vi.fn().mockRejectedValue(error),
      wait: vi.fn(),
    };

    await expect(reconcileNpmPackage(entry, adapter)).rejects.toBe(error);
    expect(adapter.wait).not.toHaveBeenCalled();
  });

  it('still fails when the staged version never converges to the expected integrity', async () => {
    const adapter = {
      npmState: vi
        .fn()
        .mockResolvedValueOnce(missingState())
        .mockResolvedValue(exactState('sha512-conflicting')),
      publish: vi.fn().mockRejectedValue(npmPublishError(entry.version)),
      wait: vi.fn(),
    };

    await expect(reconcileNpmPackage(entry, adapter)).rejects.toThrow(
      '@noodleseed/one@0.160.0 did not converge in npm',
    );
    expect(adapter.wait).toHaveBeenCalledTimes(6);
  });
});
