/**
 * Local author loop commands: validate, test, the tools/resources/prompts
 * loopback smokes, and the long-running dev server command.
 */

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ConfigLocation } from '../config.js';
import { dev, localMcpCall } from '../dev.js';
import {
  localTargetDisplay,
  resolveEffectiveLocalTarget,
  UNLINKED_LOCAL_TARGET_HINT,
} from '../local-target.js';
import { previewBannerLines, startPreviewSession } from '../preview-session.js';
import {
  readResolvedProjectConfig,
  resolveLocalEntrypoint,
  resolveLocalEntrypointResult,
} from '../project.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { startTunnel } from '../tunnel.js';
import { type ValidationIssue, validate } from '../validate.js';
import { genericHostAuthReadiness } from './auth-ops.js';
import { probeLocalCustomerAuthBoundary } from './customer-auth-smoke.js';
import { findDeployProjectRoot } from './deploy-target.js';
import {
  type LocalSmokeMethod,
  localMcpError,
  reportLocalBootFailure,
  reportLocalMcpFailure,
} from './local-readiness.js';
import { EXIT, printJsonFailure, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import {
  configuredProjectEntrypointMissing,
  formatBytes,
  missingProjectEntrypoint,
  parseCommandFlags,
  printCommandUsageFailure,
} from './shared.js';

export async function runValidate(rest: readonly string[]): Promise<number> {
  const flags = parseCommandFlags(rest, {
    values: { '--connectors': 'connectorsPath' },
    booleans: {
      '--agent-output': 'agentOutput',
      '--fix-prompt': 'agentOutput',
      '--json': 'json',
    },
  });
  const { connectorsPath, agentOutput, json } = flags;
  let manifestPath = flags.positional[0];
  if (!manifestPath) {
    const resolution = resolveLocalEntrypointResult();
    if (resolution === undefined) return missingProjectEntrypoint('validate', json);
    if (!resolution.exists) return configuredProjectEntrypointMissing('validate', resolution, json);
    manifestPath = resolution.path;
  }

  const outcome = await validate({
    manifestPath,
    ...(connectorsPath ? { connectorsPath } : {}),
  });

  // `--json` emits the uniform self-correcting envelope for an agent's deterministic repair loop: a success
  // payload for a valid manifest, or the stable failure shape with every enriched error nested in
  // `error.errors[]` for an invalid one. It applies to both valid and invalid results.
  if (json) {
    if (outcome.ok) {
      printJsonOk({
        ...(outcome.warnings !== undefined ? { warnings: outcome.warnings } : {}),
        ...(outcome.assets !== undefined ? { assets: outcome.assets } : {}),
      });
      return 0;
    }
    // A missing build dependency (e.g. Vite for React widget bundling) is not a manifest error an author
    // can fix at a `path`. Surface the exact dependency-add command instead of the generic `--fix-prompt`
    // loop: a plain package install cannot repair a dependency that was never declared.
    const needsViteInstall = outcome.errors.some(
      (error) => error.code === 'read_error' && /requires Vite/i.test(error.message),
    );
    return printJsonFailure({
      code: 'validation_failed',
      message: `${outcome.errors.length} validation error(s)`,
      fix: needsViteInstall
        ? 'Run `npm install --save-dev vite`, then re-run `noodle validate --json`.'
        : 'Fix each error at its `path` under `error.errors`, then re-run `noodle validate --json`.',
      next: needsViteInstall ? 'npm install --save-dev vite' : 'noodle validate --fix-prompt',
      errors: outcome.errors,
    });
  }

  if (outcome.ok) {
    console.log(`✓ ${manifestPath} is valid.`);
    for (const warning of outcome.warnings ?? []) console.warn(`  ⚠ ${warning}`);
    if (outcome.assets && outcome.assets.length > 0) {
      console.log(
        `  Packaged assets (deploy publishes these as public, immutable web assets — no secrets/PII):`,
      );
      for (const asset of outcome.assets) {
        console.log(
          `    ${asset.sourcePath} — ${asset.mimeType}, ${formatBytes(asset.byteLength)}`,
        );
      }
    }
    return 0;
  }

  if (agentOutput) {
    console.log(agentFixPrompt('validate', manifestPath, outcome.errors));
    return 1;
  }

  console.error(`✗ ${manifestPath} — ${outcome.errors.length} error(s) [${outcome.stage}]:`);
  for (const e of outcome.errors) {
    console.error(`  ${e.code}${e.path ? ` at ${e.path}` : ''}: ${e.message}`);
    if (e.expected !== undefined) console.error(`    expected: ${e.expected}`);
    if (e.got !== undefined) console.error(`    got: ${e.got}`);
    if (e.didYouMean !== undefined) console.error(`    did you mean "${e.didYouMean}"?`);
    else if (e.suggestions && e.suggestions.length > 0)
      console.error(`    candidates: ${e.suggestions.join(', ')}`);
    if (e.docAnchor !== undefined) console.error(`    docs: ${e.docAnchor}`);
  }
  return 1;
}

export function agentFixPrompt(
  command: string,
  subject: string,
  errors: readonly ValidationIssue[],
): string {
  const lines: string[] = [
    `Fix this Noodle validation failure from \`${command}\`.`,
    '',
    `Target: ${subject}`,
    '',
    'Errors:',
  ];
  for (const error of errors) {
    lines.push(`- ${error.code}${error.path ? ` at ${error.path}` : ''}: ${error.message}`);
    if (error.expected !== undefined) lines.push(`  expected: ${error.expected}`);
    if (error.got !== undefined) lines.push(`  got: ${error.got}`);
    if (error.didYouMean !== undefined) lines.push(`  did you mean: ${error.didYouMean}`);
    else if (error.suggestions && error.suggestions.length > 0)
      lines.push(`  candidates: ${error.suggestions.join(', ')}`);
    if (error.docAnchor !== undefined) lines.push(`  docs: ${error.docAnchor}`);
  }
  lines.push(
    '',
    'Update the Noodle app using test-driven development, then run `noodle validate` and `noodle test`.',
  );
  return lines.join('\n');
}

export async function runLocalTest(
  rest: readonly string[],
  home: ConfigLocation = homedir(),
): Promise<number> {
  const args = parseAuthorSmokeArgs(rest);
  const manifestPath = args.path ?? resolveLocalEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint('test', args.json);
  const validation = await validate(
    {
      manifestPath,
      ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
    },
    { localDevtoolsCustomerIdentity: true },
  );
  if (!validation.ok) {
    if (args.agentOutput) {
      console.log(agentFixPrompt('test', manifestPath, validation.errors));
    } else if (args.json) {
      return printJsonFailure({
        code: 'validation_failed',
        message: `${validation.errors.length} validation error(s)`,
        next: 'noodle validate --fix-prompt',
        errors: validation.errors,
      });
    } else {
      console.error(`validate: fail (${validation.errors.length} error(s))`);
    }
    return 1;
  }

  const watchDir = dirname(resolve(manifestPath));
  const projectRoot = findDeployProjectRoot(watchDir) ?? watchDir;
  const targetResolution = resolveEffectiveLocalTarget({
    manifestPath,
    cwd: projectRoot,
    home,
  });
  const target = targetResolution.target;
  const handle = await dev({
    manifestPath,
    ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
    ...target,
    projectRoot,
    watch: false,
    interactive: false,
    log: () => {},
  });
  try {
    // A connector secret that can't resolve fails the boot deploy CLOSED — the loopback smoke below
    // would then answer an opaque -32600 "not found". Name the real cause + fix instead.
    const secretFailure = reportLocalBootFailure(
      handle.boot,
      targetResolution,
      args.json,
      projectRoot,
    );
    if (secretFailure !== undefined) return secretFailure;
    const registeredTools = handle.boot.toolNames ?? [];
    const customerAuth = handle.customerAuth();
    if (customerAuth !== undefined) {
      const expectedAuthorizationServers =
        customerAuth.kind === 'oidc'
          ? [customerAuth.issuer]
          : customerAuth.kind === 'federatedOidc'
            ? customerAuth.issuers
            : undefined;
      const boundary = await probeLocalCustomerAuthBoundary(handle.url, {
        ...(expectedAuthorizationServers === undefined ? {} : { expectedAuthorizationServers }),
      });
      if (!boundary.ok) {
        if (args.json) {
          return printJsonFailure(
            {
              code: 'customer_auth_boundary_failed',
              message: boundary.message,
              fix: 'Run `noodle dev`, inspect the local unauthorized response and protected-resource metadata, then retry.',
              next: 'noodle dev',
              detail: {
                endpoint: handle.url,
                reason: boundary.reason,
                ...(boundary.status === undefined ? {} : { status: boundary.status }),
              },
            },
            EXIT.MCP,
          );
        }
        console.log('validate: pass');
        console.log(`mcp: protected boundary fail (${boundary.reason})`);
        console.log('auth: run `noodle dev` and inspect the local OAuth metadata');
        return EXIT.MCP;
      }

      if (args.tool !== undefined) {
        if (args.json) {
          return printJsonFailure(
            {
              code: 'customer_auth_interactive_required',
              message: `The protected local app did not call ${args.tool}; interactive sign-in is required.`,
              fix: 'Complete sign-in in `noodle devtools`, then invoke one safe tool there.',
              next: 'noodle devtools',
              detail: { endpoint: handle.url, boundary: 'pass', tool: args.tool },
            },
            EXIT.MCP,
          );
        }
        console.log('validate: pass');
        console.log('mcp: protected boundary pass (401 + OAuth metadata)');
        console.log(`tool: ${args.tool} not called; run \`noodle devtools\` and sign in`);
        return EXIT.MCP;
      }

      if (args.json) {
        printJsonOk({
          endpoint: handle.url,
          registeredTools,
          auth: {
            protected: true,
            boundary: 'pass',
            resource: boundary.resource,
            resourceMetadataUrl: boundary.resourceMetadataUrl,
            authorizationServers: boundary.authorizationServers,
            interactiveRequired: true,
          },
          next: 'noodle devtools',
        });
        return 0;
      }
      console.log('validate: pass');
      console.log('mcp: protected boundary pass (401 + OAuth metadata)');
      console.log(`tools: ${registeredTools.join(', ') || '(none)'} (registered, not called)`);
      console.log('auth: interactive verification required; run `noodle devtools` and sign in');
      return 0;
    }
    const init = await localMcpCall(handle.url, 'initialize', {});
    const initFailure = localMcpError(init, 'initialize');
    if (initFailure)
      return reportLocalMcpFailure({ ...initFailure, code: 'mcp_smoke_failed' }, args.json);
    const tools = await localMcpCall(handle.url, 'tools/list', {});
    const listFailure = localMcpError(tools, 'tools/list');
    if (listFailure)
      return reportLocalMcpFailure({ ...listFailure, code: 'mcp_smoke_failed' }, args.json);
    const toolList =
      (
        tools.body?.result as
          | {
              tools?: Array<{
                name: string;
                _meta?: unknown;
                outputSchema?: Record<string, unknown>;
              }>;
            }
          | undefined
      )?.tools ?? [];
    let call: unknown;
    if (args.tool !== undefined) {
      const called = await localMcpCall(handle.url, 'tools/call', {
        name: args.tool,
        arguments: parseJsonArgs(args.args),
      });
      const callFailure = localMcpError(
        called,
        'tools/call',
        toolList.find((tool) => tool.name === args.tool)?.outputSchema,
      );
      if (callFailure)
        return reportLocalMcpFailure({ ...callFailure, code: 'mcp_smoke_failed' }, args.json);
      call = called.body?.result;
    }
    if (args.json) {
      printJsonOk({
        endpoint: handle.url,
        ...(init.protocol ? { protocol: init.protocol } : {}),
        tools: toolList.map((tool) => tool.name),
        ...(call !== undefined ? { call } : {}),
      });
      return 0;
    }
    console.log('validate: pass');
    console.log(
      `mcp: initialize ${init.status === 200 ? 'pass' : 'fail'}${
        init.protocol ? ` (${init.protocol.era} ${init.protocol.version})` : ''
      }`,
    );
    console.log(`tools: ${toolList.map(formatListedTool).join(', ') || '(none)'}`);
    if (call !== undefined) printRawJsonForHumanDebug(call, 2);
    return 0;
  } finally {
    await handle.close();
  }
}

function formatListedTool(tool: { readonly name: string; readonly _meta?: unknown }): string {
  const ui = (tool._meta as { ui?: { visibility?: readonly string[] } } | undefined)?.ui;
  return ui?.visibility?.includes('app') && !ui.visibility.includes('model')
    ? `${tool.name} [app]`
    : tool.name;
}

export async function runSmoke(
  kind: 'tools' | 'resources' | 'prompts',
  rest: readonly string[],
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [action, subject, ...tail] = rest;
  const args = parseAuthorSmokeArgs(
    kind === 'tools' && action === 'list'
      ? [subject, ...tail].filter((arg): arg is string => arg !== undefined)
      : subject?.startsWith('--')
        ? [subject, ...tail]
        : tail,
  );
  const manifestPath = args.path ?? resolveLocalEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint(kind, args.json);
  const watchDir = dirname(resolve(manifestPath));
  const projectRoot = findDeployProjectRoot(watchDir) ?? watchDir;
  const targetResolution = resolveEffectiveLocalTarget({
    manifestPath,
    cwd: projectRoot,
    home,
  });
  const target = targetResolution.target;
  const handle = await dev({
    manifestPath,
    ...(args.connectorsPath ? { connectorsPath: args.connectorsPath } : {}),
    ...target,
    projectRoot,
    watch: false,
    interactive: false,
    log: () => {},
  });
  try {
    // An unresolved connector secret fails the boot CLOSED, so the call below returns an opaque
    // -32600 "not found". Report the real cause + fix before touching the endpoint.
    const secretFailure = reportLocalBootFailure(
      handle.boot,
      targetResolution,
      args.json,
      projectRoot,
    );
    if (secretFailure !== undefined) return secretFailure;
    let method: LocalSmokeMethod;
    let params: Record<string, unknown>;
    if (kind === 'tools' && action === 'list') {
      method = 'tools/list';
      params = {};
    } else if (kind === 'tools' && action === 'call' && subject !== undefined) {
      method = 'tools/call';
      params = { name: subject, arguments: parseJsonArgs(args.args) };
    } else if (kind === 'resources' && action === 'read' && subject !== undefined) {
      method = 'resources/read';
      params = { uri: subject };
    } else if (kind === 'prompts' && action === 'get' && subject !== undefined) {
      method = 'prompts/get';
      params = { name: subject, arguments: parseJsonArgs(args.args) };
    } else {
      return printCommandUsageFailure(
        kind,
        `noodle ${kind}: a supported action and subject are required`,
        `noodle ${kind} --help`,
        args.json,
      );
    }
    let outputSchema: Record<string, unknown> | undefined;
    if (method === 'tools/call') {
      const listed = await localMcpCall(handle.url, 'tools/list', {});
      const failure = localMcpError(listed, 'tools/list');
      if (failure) return reportLocalMcpFailure(failure, args.json);
      const result = listed.body?.result as {
        tools: Array<{ name: string; outputSchema?: Record<string, unknown> }>;
      };
      outputSchema = result.tools.find((tool) => tool.name === subject)?.outputSchema;
    }
    const response = await localMcpCall(handle.url, method, params);
    const failure = localMcpError(response, method, outputSchema);
    if (failure) return reportLocalMcpFailure(failure, args.json);
    if (args.json) {
      printJsonOk({
        endpoint: handle.url,
        result: response.body?.result,
        ...smokeTopLevel(kind, action, response.body?.result),
      });
    } else if (kind === 'tools' && action === 'list') {
      const tools =
        (response.body?.result as { tools?: readonly ListedToolRow[] } | undefined)?.tools ?? [];
      console.log(renderToolsTable(tools, stdoutTableOptions()));
    } else {
      printRawJsonForHumanDebug(response.body?.result, 2);
    }
    return 0;
  } finally {
    await handle.close();
  }
}

// --- table rendering ---------------------------------------------------------------

/** The `tools/list` fields the branded `noodle tools list` table renders. */
export interface ListedToolRow {
  readonly name: string;
  readonly description?: string;
}

const TOOLS_COLUMNS: readonly Column<ListedToolRow>[] = [
  { header: 'NAME', get: (t) => t.name },
  { header: 'DESCRIPTION', get: (t) => t.description ?? '', maxWidth: 60 },
];

/** Render the `tools list` table (founder-approved design, 2026-07-06). Exported for tests. */
export function renderToolsTable(tools: readonly ListedToolRow[], opts: TableOptions): string {
  return renderTable(TOOLS_COLUMNS, tools, opts);
}

function smokeTopLevel(
  kind: string,
  action: string | undefined,
  result: unknown,
): Record<string, unknown> {
  if (kind === 'tools' && action === 'list') {
    return { tools: (result as { tools?: unknown } | undefined)?.tools ?? [] };
  }
  return {};
}

export function parseAuthorSmokeArgs(rest: readonly string[]): {
  readonly path?: string;
  readonly connectorsPath?: string;
  readonly tool?: string;
  readonly args?: string;
  readonly target?: string;
  readonly minSeverity?: string;
  readonly json: boolean;
  readonly agentOutput: boolean;
} {
  const { positional, ...args } = parseCommandFlags(rest, {
    values: {
      '--connectors': 'connectorsPath',
      '--tool': 'tool',
      '--args': 'args',
      '--target': 'target',
      '--min-severity': 'minSeverity',
    },
    booleans: {
      '--json': 'json',
      '--agent-output': 'agentOutput',
      '--fix-prompt': 'agentOutput',
    },
  });
  return {
    ...args,
    ...(positional[0] !== undefined ? { path: positional[0] } : {}),
  };
}

function parseJsonArgs(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export async function runDev(
  rest: readonly string[],
  _env: NodeJS.ProcessEnv,
  home: ConfigLocation = homedir(),
): Promise<number> {
  let manifestPath: string | undefined;
  let connectorsPath: string | undefined;
  let org: string | undefined;
  let app: string | undefined;
  let targetEnv: string | undefined;
  let port: number | undefined;
  let tunnel = false;
  let noPreview = false;
  let accessMode: string | undefined;
  let previewForce = false;
  let previewPort: number | undefined;
  let model: string | undefined;
  let theme: 'light' | 'dark' | 'both' = 'both';
  let device: 'desktop' | 'mobile' | 'both' = 'both';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--connectors') connectorsPath = rest[++i];
    else if (arg === '--secrets') {
      console.error('dev: --secrets is no longer supported; use `noodle secrets set`');
      return 2;
    } else if (arg === '--org') org = rest[++i];
    else if (arg === '--app') app = rest[++i];
    else if (arg === '--env') targetEnv = rest[++i];
    else if (arg === '--port') port = Number(rest[++i]);
    else if (arg === '--tunnel') tunnel = true;
    else if (arg === '--access') {
      accessMode = rest[++i];
      if (accessMode !== 'mixed' && accessMode !== 'customers') {
        console.error(
          'dev: --access must be mixed or customers; hosted identity modes are unavailable locally.',
        );
        return 2;
      }
    } else if (arg === '--no-preview') noPreview = true;
    else if (arg === '--preview') previewForce = true;
    else if (arg === '--preview-port') previewPort = Number(rest[++i]);
    else if (arg === '--model') model = rest[++i];
    else if (arg === '--theme') {
      const v = rest[++i];
      theme = v === 'light' || v === 'dark' ? v : 'both';
    } else if (arg === '--device') {
      const v = rest[++i];
      device = v === 'desktop' || v === 'mobile' ? v : 'both';
    } else if (!manifestPath && arg !== undefined && !arg.startsWith('--')) manifestPath = arg;
  }
  if (!manifestPath) manifestPath = resolveLocalEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint('dev');

  const watchDir = dirname(resolve(manifestPath));
  const projectRoot = findDeployProjectRoot(watchDir) ?? watchDir;
  accessMode ??= _env.NOODLE_ACCESS_MODE ?? readResolvedProjectConfig(projectRoot).accessMode;
  if (accessMode !== undefined && accessMode !== 'mixed' && accessMode !== 'customers') {
    console.error(
      'dev: local access must be mixed or customers; use --access to override the hosted project setting.',
    );
    return 2;
  }

  const previewOn = !noPreview && (previewForce || process.stdin.isTTY === true);

  // With the preview on, dev's own logging/prompt/entrypoint-watcher are suppressed (the preview session
  // owns the recursive watcher and prints the banner). Validate first so compile errors still surface.
  if (previewOn) {
    const validation = await validate(
      {
        manifestPath,
        ...(connectorsPath ? { connectorsPath } : {}),
      },
      { localDevtoolsCustomerIdentity: true },
    );
    if (!validation.ok) {
      console.log('Noodle dev: validation failed');
      for (const issue of validation.errors) console.log(`ERROR ${issue.code}: ${issue.message}`);
      return 1;
    }
    const authFailures = await genericHostAuthReadiness(manifestPath);
    if (authFailures.length > 0) {
      console.error('Noodle dev: authentication readiness failed');
      for (const failure of authFailures) {
        console.error(`FAIL ${failure.name}: ${failure.message}`);
        if (failure.fix !== undefined) console.error(`  Fix: ${failure.fix}`);
      }
      return 1;
    }
  }

  let handle: Awaited<ReturnType<typeof dev>>;
  const targetResolution = resolveEffectiveLocalTarget({
    manifestPath,
    cwd: projectRoot,
    home,
    ...(org !== undefined ? { org } : {}),
    ...(app !== undefined ? { app } : {}),
    ...(targetEnv !== undefined ? { env: targetEnv } : {}),
  });
  const target = targetResolution.target;
  try {
    handle = await dev({
      manifestPath,
      ...(accessMode === undefined ? {} : { accessMode }),
      ...(connectorsPath ? { connectorsPath } : {}),
      ...target,
      projectRoot,
      ...(port !== undefined ? { port } : {}),
      ...(previewOn ? { watch: false, interactive: false, log: () => {} } : {}),
    });
  } catch (error) {
    console.error(`dev: ${(error as Error).message}`);
    return 1;
  }

  // A required connector secret that couldn't resolve fails the boot CLOSED — nothing is served, and
  // the preview (which suppresses dev's own log) would otherwise sit against a dead endpoint. With no
  // clear cause the loopback just answers -32600 "not found". Surface the real cause + fix, then bail.
  const secretFailure = reportLocalBootFailure(handle.boot, targetResolution, false, projectRoot);
  if (secretFailure !== undefined) {
    await handle.close();
    return secretFailure;
  }

  if (!previewOn) {
    console.log(`Local target: ${localTargetDisplay(targetResolution)}`);
    if (targetResolution.ignoredSavedTarget) console.log(UNLINKED_LOCAL_TARGET_HINT);
  }

  // Preview UI (default on in a TTY): one in-process preview server + watcher on the SAME dev runtime — no
  // second process, port, or reload channel to coordinate. `--no-preview` opts out; non-TTY stays headless.
  let session: Awaited<ReturnType<typeof startPreviewSession>> | undefined;
  if (previewOn) {
    try {
      session = await startPreviewSession({
        handle,
        ...(accessMode === undefined ? {} : { accessMode }),
        watchDir,
        theme,
        device,
        ...(previewPort !== undefined && Number.isFinite(previewPort) ? { port: previewPort } : {}),
        ...(model !== undefined ? { model } : {}),
      });
    } catch (error) {
      console.error(
        `dev: could not start the preview server: ${error instanceof Error ? error.message : String(error)}`,
      );
      await handle.close();
      return 1;
    }
    for (const line of previewBannerLines(session, {
      title: 'noodle dev',
      mcpUrl: handle.url,
      theme,
      device,
      ...(model !== undefined ? { model } : {}),
      watchDir,
      localTarget: targetResolution,
    })) {
      console.log(line);
    }
  }

  let tunnelHandle: Awaited<ReturnType<typeof startTunnel>> | undefined;
  if (tunnel) {
    try {
      tunnelHandle = await startTunnel({ localOrigin: handle.origin, localMcpUrl: handle.url });
    } catch (error) {
      console.error(`dev: ${(error as Error).message}`);
      if (session) await session.close();
      await handle.close();
      return 1;
    }
    console.log(`Public MCP endpoint: ${tunnelHandle.publicMcpUrl}`);
    const customerAuth = handle.customerAuth();
    if (customerAuth === undefined) {
      console.log(
        'Disclosure: traffic transits Cloudflare and this auth-open dev server is publicly reachable while the tunnel is up.',
      );
    } else {
      console.log(
        'Disclosure: traffic transits Cloudflare. This server requires its configured customer auth, and the authorization server must allow the public tunnel URL as a distinct OAuth resource.',
      );
    }
  } else {
    console.log(
      'Tip: run `noodle dev --tunnel` to reach this server from cloud AI clients (Claude.ai, ChatGPT).',
    );
  }

  // Keep the process alive until interrupted, then tear the preview + tunnel + local server down.
  await new Promise<void>((done) => {
    const stop = (): void => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('\nShutting down dev server.');
  if (session) await session.close();
  if (tunnelHandle) await tunnelHandle.close();
  await handle.close();
  return 0;
}
