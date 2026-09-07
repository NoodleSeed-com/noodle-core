import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import type { ConfigLocation } from '../config.js';
import { dev } from '../dev.js';
import { resolveEffectiveLocalTarget } from '../local-target.js';
import { previewBannerLines, startPreviewSession } from '../preview-session.js';
import { resolveLinkedEntrypoint } from '../project.js';
import { validate } from '../validate.js';
import { genericHostAuthReadiness } from './auth-ops.js';
import { findDeployProjectRoot } from './deploy-target.js';
import { reportLocalBootFailure } from './local-readiness.js';
import { missingProjectEntrypoint, parseCommandFlags, waitForShutdownSignal } from './shared.js';

export async function runDevtools(
  rest: readonly string[],
  home: ConfigLocation = homedir(),
): Promise<number> {
  const args = parseDevtoolsArgs(rest);
  const manifestPath = args.path ?? resolveLinkedEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint('devtools');

  const validation = await validate(
    {
      manifestPath,
      ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
    },
    { localDevtoolsCustomerIdentity: true },
  );
  if (!validation.ok) {
    console.log('Noodle devtools: validation failed');
    for (const error of validation.errors) console.log(`ERROR ${error.code}: ${error.message}`);
    return 1;
  }

  const authFailures = await genericHostAuthReadiness(manifestPath);
  if (authFailures.length > 0) {
    console.error('Noodle devtools: authentication readiness failed');
    for (const failure of authFailures) {
      console.error(`FAIL ${failure.name}: ${failure.message}`);
      if (failure.fix !== undefined) console.error(`  Fix: ${failure.fix}`);
    }
    return 1;
  }

  const watchDir = dirname(resolve(manifestPath));
  const projectRoot = findDeployProjectRoot(watchDir) ?? watchDir;
  const targetResolution = resolveEffectiveLocalTarget({ manifestPath, cwd: projectRoot, home });
  const target = targetResolution.target;
  const handle = await dev({
    manifestPath,
    ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
    ...target,
    // The preview session owns the file watch (so it can rebuild widgets AND live-reload the browser); dev's
    // own entrypoint-only watcher would miss imported view files (e.g. views/*.tsx).
    watch: false,
    interactive: false,
    log: () => {},
    projectRoot,
  });

  const bootFailure = reportLocalBootFailure(handle.boot, targetResolution, false, projectRoot);
  if (bootFailure !== undefined) {
    await handle.close();
    return bootFailure;
  }

  const entrypoint = relative(projectRoot, resolve(manifestPath));
  let session: Awaited<ReturnType<typeof startPreviewSession>>;
  try {
    session = await startPreviewSession({
      handle,
      watchDir,
      theme: args.theme,
      device: args.device,
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      design: { projectRoot, entrypoint },
    });
  } catch (error) {
    // A preview bind failure (port in use / permission) shouldn't leave the dev server running.
    await handle.close();
    console.error(
      `devtools: could not start the preview server: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  for (const line of previewBannerLines(session, {
    title: 'noodle devtools',
    mcpUrl: handle.url,
    theme: args.theme,
    device: args.device,
    ...(args.model !== undefined ? { model: args.model } : {}),
    watchDir,
    localTarget: targetResolution,
  })) {
    console.log(line);
  }

  async function shutdown(): Promise<void> {
    await session.close();
    await handle.close();
  }

  if (args.headless) {
    // Headless: stay up until an operator/orchestrator sends SIGINT or SIGTERM, regardless of TTY.
    // (Without --headless the non-TTY branch below shuts down immediately, which is wrong for a
    // background preview an agent wants to keep serving.)
    console.log('Running headless. Send SIGINT or SIGTERM to stop.');
    await waitForShutdownSignal(['SIGINT', 'SIGTERM'], shutdown);
  } else if (process.stdin.isTTY) {
    console.log('Press Ctrl-C to stop.');
    await waitForShutdownSignal(['SIGINT'], shutdown);
  } else {
    await shutdown();
  }
  return 0;
}

// Exported for focused arg-parse tests; not part of the CLI dispatch surface (cli.ts calls runDevtools).
export function parseDevtoolsArgs(rest: readonly string[]): {
  readonly path?: string;
  readonly connectorsPath?: string;
  readonly port?: number;
  readonly theme: 'light' | 'dark' | 'both';
  readonly device: 'desktop' | 'mobile' | 'both';
  readonly model?: string;
  readonly headless: boolean;
} {
  const flags = parseCommandFlags(rest, {
    values: {
      '--connectors': 'connectorsPath',
      '--port': 'port',
      '--model': 'model',
      '--theme': 'theme',
      '--device': 'device',
    },
    booleans: { '--headless': 'headless', '--open': 'open' },
  });
  const port = Number(flags.port);
  return {
    ...(flags.positional[0] !== undefined ? { path: flags.positional[0] } : {}),
    ...(flags.connectorsPath !== undefined ? { connectorsPath: flags.connectorsPath } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    theme: parseChoice(flags.theme, ['light', 'dark', 'both'], 'both'),
    device: parseChoice(flags.device, ['desktop', 'mobile', 'both'], 'both'),
    headless: flags.headless,
  };
}

function parseChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
