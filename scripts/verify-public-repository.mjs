#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_VERIFICATION_STAGES = Object.freeze([
  {
    name: 'install',
    command: 'pnpm',
    args: ['install', '--frozen-lockfile', '--ignore-scripts'],
  },
  {
    name: 'browser',
    command: 'pnpm',
    args: ['exec', 'playwright', 'install', 'chromium'],
  },
  { name: 'lint', command: 'pnpm', args: ['lint'] },
  { name: 'build', command: 'pnpm', args: ['build'] },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
  { name: 'test', command: 'pnpm', args: ['test'] },
  { name: 'package-boundary', command: 'pnpm', args: ['package-boundary-gate'] },
  { name: 'license', command: 'pnpm', args: ['license-gate'] },
  { name: 'size', command: 'pnpm', args: ['size-gate'] },
  { name: 'escape-hatch', command: 'pnpm', args: ['escape-hatch-gate'] },
  { name: 'public-docs', command: 'pnpm', args: ['docs:check'] },
  { name: 'self-host-e2e', command: 'node', args: ['scripts/self-host-e2e.mjs'] },
]);

export class PublicVerificationFailure extends Error {
  constructor(stage, summary) {
    super(`public verification failed at ${stage}: ${summary}`);
    this.name = 'PublicVerificationFailure';
    this.stage = stage;
  }
}

function processRunner() {
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args, {
          cwd: input.cwd,
          env: { ...process.env },
          stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (signal !== null) reject(new Error(`terminated by signal ${signal}`));
          else if (code !== 0) reject(new Error(`exited with code ${String(code)}`));
          else resolve();
        });
      });
    },
  };
}

export async function runPublicVerification(input) {
  const runner = input.runner ?? processRunner();
  const pnpmPath = input.pnpmPath ?? 'pnpm';
  const nodePath = input.nodePath ?? 'node';
  const dockerPath = input.dockerPath ?? 'docker';
  const trustedMode =
    input.pnpmPath !== undefined || input.nodePath !== undefined || input.dockerPath !== undefined;
  if (trustedMode) {
    if (!isAbsolute(pnpmPath)) {
      throw new Error('trusted public verification requires an absolute pnpm path');
    }
    if (!isAbsolute(dockerPath)) {
      throw new Error('trusted public verification requires an absolute Docker path');
    }
    if (!isAbsolute(nodePath)) {
      throw new Error('trusted public verification requires an absolute Node path');
    }
  }
  const completed = [];
  for (const stage of PUBLIC_VERIFICATION_STAGES) {
    console.log(`public verification: ${stage.name}`);
    try {
      await runner.run({
        ...stage,
        command:
          stage.command === 'pnpm' ? pnpmPath : stage.command === 'node' ? nodePath : stage.command,
        args:
          trustedMode && stage.name === 'self-host-e2e'
            ? [...stage.args, '--docker', dockerPath]
            : stage.args,
        cwd: input.root,
      });
      completed.push(stage.name);
    } catch (error) {
      throw new PublicVerificationFailure(
        stage.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return completed;
}

const direct =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  try {
    const args = process.argv.slice(2);
    let pnpmPath;
    let dockerPath;
    if (args.length !== 0) {
      if (args.length !== 4) {
        throw new Error(
          'usage: verify-public-repository.mjs [--pnpm <absolute-path> --docker <absolute-path>]',
        );
      }
      const options = new Map();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!['--pnpm', '--docker'].includes(name) || options.has(name)) {
          throw new Error(
            'usage: verify-public-repository.mjs [--pnpm <absolute-path> --docker <absolute-path>]',
          );
        }
        options.set(name, value);
      }
      pnpmPath = options.get('--pnpm');
      dockerPath = options.get('--docker');
    }
    await runPublicVerification({
      root: process.cwd(),
      pnpmPath,
      nodePath: pnpmPath === undefined ? undefined : process.execPath,
      dockerPath,
    });
    console.log('public verification: all stages passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
