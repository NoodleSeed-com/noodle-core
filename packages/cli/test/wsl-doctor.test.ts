import { describe, expect, it } from 'vitest';
import { wslPlatformChecks } from '../src/platform-support.js';

describe('WSL doctor diagnostics', () => {
  it('does not add WSL checks outside WSL', () => {
    expect(
      wslPlatformChecks({
        platform: 'darwin',
        env: {},
        cwd: '/Users/dev/app',
        nodePath: '/opt/homebrew/bin/node',
        npmPath: '/opt/homebrew/bin/npm',
        kernelRelease: '25.5.0',
      }),
    ).toEqual([]);
  });

  it('identifies a healthy WSL2 environment', () => {
    expect(
      wslPlatformChecks({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WSL_INTEROP: '/run/WSL/1_interop' },
        cwd: '/home/dev/app',
        nodePath: '/usr/bin/node',
        npmPath: '/usr/bin/npm',
        kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      }),
    ).toEqual([{ level: 'PASS', name: 'Platform', message: 'WSL2 (Ubuntu-24.04)' }]);
  });

  it('warns when WSL2 cannot be confirmed', () => {
    expect(
      wslPlatformChecks({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        cwd: '/home/dev/app',
        nodePath: '/usr/bin/node',
        npmPath: '/usr/bin/npm',
        kernelRelease: '4.4.0-22621-Microsoft',
      }),
    ).toEqual([
      {
        level: 'WARN',
        name: 'Platform',
        message: 'WSL version 2 not detected (Ubuntu)',
        cause: 'The supported Windows environment is WSL2 with Ubuntu.',
        fix: 'Upgrade this distro to WSL2 from PowerShell.',
        next: 'wsl.exe --set-version Ubuntu 2',
      },
    ]);
  });

  it('warns when WSL2 is using a distro outside the supported Ubuntu target', () => {
    expect(
      wslPlatformChecks({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Debian' },
        cwd: '/home/dev/app',
        nodePath: '/usr/bin/node',
        npmPath: '/usr/bin/npm',
        kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      }),
    ).toEqual([
      {
        level: 'WARN',
        name: 'Platform',
        message: 'WSL2 distro is not Ubuntu (Debian)',
        cause: 'The supported Windows environment is WSL2 with Ubuntu.',
        fix: 'Install the supported Ubuntu distro for Noodle CLI work.',
        next: 'wsl.exe --install -d Ubuntu',
      },
    ]);
  });

  it('warns when a WSL2 distro cannot be identified', () => {
    expect(
      wslPlatformChecks({
        platform: 'linux',
        env: { WSL_INTEROP: '/run/WSL/1_interop' },
        cwd: '/home/dev/app',
        nodePath: '/usr/bin/node',
        npmPath: '/usr/bin/npm',
        kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      }),
    ).toEqual([
      {
        level: 'WARN',
        name: 'Platform',
        message: 'WSL2 distro could not be identified',
        cause: 'The supported Windows environment is WSL2 with Ubuntu.',
        fix: 'Run Noodle from an Ubuntu WSL2 terminal.',
        next: 'wsl.exe --list --verbose',
      },
    ]);
  });

  it('warns when the project or Node/npm resolve through mounted Windows paths', () => {
    expect(
      wslPlatformChecks({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        cwd: '/mnt/c/Users/dev/source/app',
        nodePath: '/mnt/c/Program Files/nodejs/node.exe',
        npmPath: '/mnt/c/Program Files/nodejs/npm',
        kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      }),
    ).toEqual([
      { level: 'PASS', name: 'Platform', message: 'WSL2 (Ubuntu)' },
      {
        level: 'WARN',
        name: 'WSL workspace',
        message: '/mnt/c/Users/dev/source/app',
        cause:
          'The project is on a mounted Windows drive, which makes Node file watching and installs slower and less reliable.',
        fix: 'Move the repository into the WSL Linux filesystem, such as ~/src.',
        next: 'mkdir -p ~/src',
      },
      {
        level: 'WARN',
        name: 'WSL runtime',
        message: 'mounted Windows Node/npm detected',
        cause:
          'Node or npm resolves from /mnt, so the CLI is mixing Windows tools with the WSL environment.',
        fix: 'Install Node 24 and npm inside WSL, then ensure the Linux binaries appear first on PATH.',
        next: 'command -v node && command -v npm',
      },
    ]);
  });
});
