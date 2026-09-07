#!/usr/bin/env node
import { isSupportedNodeVersion, unsupportedNodeMessage } from './node-version.js';
import { enforcePlatformSupport } from './platform-support.js';

const argv = process.argv.slice(2);
const platformExit = enforcePlatformSupport(argv, process.platform);

if (platformExit !== undefined) {
  process.exitCode = platformExit;
} else if (!isSupportedNodeVersion()) {
  console.error(unsupportedNodeMessage());
  process.exitCode = 1;
} else {
  const { run } = await import('./cli.js');
  run(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
