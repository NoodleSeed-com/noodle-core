#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  assertSelfHostRootAvailable,
  createExactProjectCleanup,
  createProcessRunner,
  runSelfHostE2E,
} from './lib/self-host-e2e.mjs';

const args = process.argv.slice(2);
let dockerPath;
if (args.length !== 0) {
  if (args.length !== 2 || args[0] !== '--docker' || !isAbsolute(args[1])) {
    throw new Error('usage: self-host-e2e.mjs [--docker <absolute-path>]');
  }
  dockerPath = args[1];
}

const root = await realpath(process.cwd());
const projectName = `noodle-e2e-${randomBytes(8).toString('hex')}`;
const runner = createProcessRunner();
const abort = new AbortController();
let cleanup = async () => undefined;
let interruptedSignal;

function interrupt(signal) {
  if (interruptedSignal !== undefined) return;
  interruptedSignal = signal;
  abort.abort();
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
}

const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');

try {
  await assertSelfHostRootAvailable(root);
  cleanup = createExactProjectCleanup({
    root,
    projectName,
    dockerPath,
    runner,
    removeGeneratedState: true,
  });
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const results = await runSelfHostE2E({
    root,
    projectName,
    dockerPath,
    nodePath: process.execPath,
    runner,
    fetch,
    cleanup,
    signal: abort.signal,
    report: (message) => console.log(`self-host:e2e ${message}`),
  });
  if (interruptedSignal === undefined) {
    for (const result of results)
      console.log(`self-host:e2e ${result.name}: ${result.detail ?? 'ok'}`);
  }
} catch (error) {
  if (interruptedSignal === undefined) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.safeTail) console.error(error.safeTail);
    process.exitCode = 1;
  } else {
    console.error(`self-host:e2e interrupted by ${interruptedSignal}`);
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}
