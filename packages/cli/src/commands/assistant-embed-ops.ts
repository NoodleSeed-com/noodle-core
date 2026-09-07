/**
 * `noodle assistant embed --framework nextjs`: scaffold the embedding-app side of the
 * customer-branded assistant into an EXISTING web application — backend session route,
 * client-only mount, env example, plus the coding-agent instructions for Claude Code and Codex
 * (same machinery as `noodle agents setup --write`). Per-file reconcile: create missing files,
 * report identical files `unchanged`, preserve user-modified files (`skipped`) unless `--force`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type AgentSetupReport, setupAgents } from '../agents.js';
import {
  applyEmbedInstallation,
  assertEmbedOutputPaths,
  type EmbedFileAction,
  embedNextSteps,
  embedRecipe,
  prepareEmbedInstallation,
} from '../assistant-embed-installation.js';
import { type EmbedSurface, embedScaffoldFiles } from '../assistant-embed-scaffold-template.js';
import type { ConfigLocation } from '../config.js';
import { EXIT, printJsonOk } from './output.js';
import { printCliFailure } from './shared.js';

const HOST_ENVIRONMENT_NAMES = [
  'NOODLE_SERVICE_URL',
  'NOODLE_ASSISTANT_CLIENT_ID',
  'NOODLE_ASSISTANT_CLIENT_SECRET',
  'PUBLIC_APP_ORIGIN',
] as const;

/** A public embed has no backend exchange and no client secret: the embed id is not a credential. */
const PUBLIC_ENVIRONMENT_NAMES = ['NOODLE_SERVICE_URL', 'PUBLIC_APP_ORIGIN'] as const;

const HOST_SURFACES = ['authenticated', 'public', 'mixed'] as const;
type HostSurface = (typeof HOST_SURFACES)[number];

/**
 * Script-tag embeds need the service in script-src; the bundled React mount does not.
 * Unknown public mounts retain the conservative script-tag check until inspected in a browser.
 */
function cspDirectivesFor(surface: HostSurface, dir: string): readonly string[] {
  const bundledReact = readExistingFiles(dir, NEXT_CLIENT_MOUNT_FILES).some(({ content }) =>
    /import\(['"]@noodleseed\/assistant\/react['"]\)/.test(content),
  );
  return surface === 'authenticated' || bundledReact
    ? ['connect-src', 'frame-src']
    : ['script-src', 'connect-src', 'frame-src'];
}

const NEXT_CSP_FILES = [
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
  'middleware.ts',
  'middleware.js',
  'vercel.json',
] as const;

const NEXT_SESSION_ROUTE_FILES = [
  'app/api/assistant/session/route.ts',
  'app/api/assistant/session/route.js',
] as const;

const NEXT_CLIENT_MOUNT_FILES = [
  'components/noodle-assistant.tsx',
  'components/noodle-assistant.jsx',
] as const;

const DJANGO_CSP_FILES = ['nginx.conf', 'public/_headers', 'netlify.toml', 'vercel.json'] as const;
const DJANGO_SESSION_FILES = ['noodle_assistant/views.py'] as const;
const VUE_CLIENT_FILES = ['src/components/NoodleAssistant.vue'] as const;

interface HostCspCheck {
  readonly status: 'ready' | 'not-detected' | 'missing-directives' | 'unverified';
  readonly files: readonly string[];
  readonly missingDirectives?: readonly string[];
  readonly fix?: string;
}

interface HostDiagnostic {
  readonly status:
    | 'ready'
    | 'missing'
    | 'invalid'
    | 'mcp-endpoint'
    | 'not-applicable'
    | 'not-detected'
    | 'html-redirect-risk'
    | 'unverified'
    | 'ssr-risk'
    | 'cross-origin-risk';
  readonly files?: readonly string[];
}

interface HostDiagnostics {
  readonly serviceUrl: HostDiagnostic;
  readonly sessionRoute: HostDiagnostic & { readonly files: readonly string[] };
  readonly clientMount: HostDiagnostic & { readonly files: readonly string[] };
  readonly sessionCookies: HostDiagnostic & { readonly files: readonly string[] };
}

const EVIDENCE_LEVELS = [
  'static-host',
  'local-contract',
  'hosted-session',
  'production-browser',
  'operations',
] as const;

const POST_DEPLOY_PROBES = [
  {
    id: 'session-exchange',
    method: 'POST',
    path: '/api/assistant/session',
    proves: 'Signed-out denial and signed-in assistant session exchange at the production host.',
  },
  {
    id: 'assistant-doctor',
    command:
      'noodle assistant doctor --user-id <real-test-user> --origin "$PUBLIC_APP_ORIGIN" --org <org> --app <app> --env <env> --json',
    proves: 'Active deployment, backend client, exact origin, and delegated credential exchanges.',
  },
  {
    id: 'browser-flow',
    action:
      'Submit with the keyboard, inspect the console, complete one turn, and render one linked App.',
    proves:
      'The production host CSP, session route, turn stream, and hosted App frame work together.',
  },
] as const;

function postDeployProbes(surface: HostSurface) {
  if (surface !== 'public') return POST_DEPLOY_PROBES;
  return [
    {
      id: 'public-admission',
      action:
        'Load the configured public embed at an allowed origin, then test a disallowed origin and private capability denial.',
      proves:
        'Anonymous admission and the public capability boundary, not authenticated session exchange.',
    },
    {
      id: 'browser-flow',
      action:
        'Complete anonymous discovery and a safe handoff in the real browser, inspecting CSP, the turn stream, and any linked App.',
      proves: 'The public browser workflow works without a customer backend session route.',
    },
  ];
}

export async function runAssistantEmbed(
  rest: readonly string[],
  _home: ConfigLocation,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const json = rest.includes('--json');
  const force = rest.includes('--force');
  const dryRun = rest.includes('--dry-run');
  const noAgents = rest.includes('--no-agents');
  const framework = flagValue(rest, '--framework') ?? 'nextjs';
  const dir = resolve(flagValue(rest, '--dir') ?? '.');
  if (framework !== 'nextjs' && framework !== 'django-vue') {
    return printCliFailure(
      'assistant',
      {
        code: 'unsupported_framework',
        message: `The embed scaffold does not support "${framework}" yet.`,
        cause:
          'The supported profiles are nextjs and authenticated django-vue; other hosts use the framework-neutral contract.',
        fix: 'Use --framework nextjs or --framework django-vue, or follow the framework-neutral integration contract.',
        next: 'noodle assistant embed --framework nextjs',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  const requestedSurface = flagValue(rest, '--surface') ?? 'authenticated';
  if (!HOST_SURFACES.includes(requestedSurface as HostSurface)) {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_host_surface_invalid',
        message: 'The host surface is not recognized.',
        cause: '--surface must be authenticated, public, or mixed.',
        fix: 'Pass the surface mode the deployment declares for this page.',
        next: 'noodle assistant embed --surface public --dry-run --json',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  const surface = requestedSurface as EmbedSurface;
  if (framework === 'django-vue' && surface !== 'authenticated') {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_host_surface_unsupported',
        message: 'The Django/Vue profile supports authenticated surfaces only.',
        cause: 'Public and mixed generated profiles are qualified only for nextjs.',
        fix: 'Use the authenticated profile, or the framework-neutral public integration contract.',
        next: 'noodle assistant embed --framework django-vue --surface authenticated --dry-run --json',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  if (rest.includes('--check')) return checkHost(rest, framework, dir, env, json);

  const contents = embedScaffoldFiles(framework, surface);
  let files: readonly EmbedFileAction[];
  let agents: AgentSetupReport | undefined;
  const agentOptions = {
    agents: ['codex', 'claude-code'] as const,
    project: dir,
    force,
    json,
  };
  try {
    files = prepareEmbedInstallation(dir, contents, { force, dryRun });
    agents = noAgents ? undefined : setupAgents({ ...agentOptions, write: false });
    if (agents)
      assertEmbedOutputPaths(
        dir,
        agents.files.map((file) => file.path),
      );
    if (!dryRun) {
      applyEmbedInstallation(dir, contents, files);
      if (!noAgents) agents = setupAgents({ ...agentOptions, write: true });
    }
  } catch (error) {
    const unsafe = error instanceof Error && error.message === 'assistant_embed_unsafe_path';
    return printCliFailure(
      'assistant',
      {
        code: unsafe ? 'assistant_embed_unsafe_path' : 'assistant_embed_write_failed',
        message: unsafe
          ? 'An integration output traverses a symbolic link.'
          : 'The integration files could not be reconciled.',
        cause: 'Installation requires ordinary files inside the selected application directory.',
        fix: 'Inspect the output paths and permissions, preserve customer edits, and preview again.',
        next: `noodle assistant embed --surface ${surface} --dry-run --json`,
        exitCode: EXIT.FAILURE,
      },
      json,
    );
  }

  const report = {
    framework,
    surface,
    dryRun,
    dir,
    files,
    recipe: embedRecipe(framework, surface, files),
    integrationVerified: false,
    nextSteps: embedNextSteps(surface, framework),
    ...(agents !== undefined
      ? {
          agentFiles: agents.files.filter((file) => file.action !== 'unchanged').length,
          agentInstructions: agents.files,
          agentNext:
            'Read the installed project instructions and NOODLE-INTEGRATION.md before editing; reload only if your agent cannot discover new skills.',
        }
      : {}),
  };
  if (json) printJsonOk(report);
  else {
    for (const file of files)
      console.log(`${dryRun ? 'planned ' : ''}${file.action}: ${file.path}`);
    if (agents !== undefined) {
      console.log(
        `Agent instructions ${dryRun ? 'planned' : 'reconciled'} (${report.agentFiles} file(s)).`,
      );
    }
    console.log('');
    console.log('Next steps:');
    for (const [index, step] of report.nextSteps.entries()) console.log(`  ${index + 1}. ${step}`);
    console.log('  Guide: https://docs.noodleseed.dev/docs/guides/embedded-assistant');
  }
  return EXIT.OK;
}

function checkHost(
  rest: readonly string[],
  framework: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  json: boolean,
): number {
  if (hasFlagWithoutValue(rest, '--require-env')) {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_host_env_name_missing',
        message: 'An additional host environment name is missing.',
        cause: '--require-env must be followed by one environment name.',
        fix: 'Pass a name such as --require-env EXAMPLE_DELEG_CLIENT_SECRET.',
        next: 'noodle assistant embed --check --json',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  const additionalNames = flagValues(rest, '--require-env');
  const invalidName = additionalNames.find((name) => !/^[A-Z][A-Z0-9_]*$/.test(name));
  if (invalidName !== undefined) {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_host_env_name_invalid',
        message: 'One host environment name is invalid.',
        cause: 'Environment names must use uppercase letters, digits, and underscores.',
        fix: 'Pass a name such as EXAMPLE_DELEG_CLIENT_SECRET.',
        next: 'noodle assistant embed --check --json',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }

  const surface = (flagValue(rest, '--surface') ?? 'authenticated') as HostSurface;
  const aliasArguments = flagValues(rest, '--env-alias');
  const invalidAlias = aliasArguments.find(
    (entry) => !/^[A-Z][A-Z0-9_]*=[A-Z][A-Z0-9_]*$/.test(entry),
  );
  if (invalidAlias !== undefined || aliasArguments.length !== flagCount(rest, '--env-alias')) {
    return printCliFailure(
      'assistant',
      {
        code: 'assistant_host_env_alias_invalid',
        message: 'One host environment alias is invalid.',
        cause: '--env-alias takes NAME=HOST_NAME with uppercase letters, digits, and underscores.',
        fix: 'Pass an alias such as --env-alias NOODLE_SERVICE_URL=MY_NOODLE_URL.',
        next: 'noodle assistant embed --check --json',
        exitCode: EXIT.USAGE,
      },
      json,
    );
  }
  // Aliases let a host repo keep its own env naming; the check follows the name the repo uses.
  const aliases = Object.fromEntries(
    aliasArguments.map((entry) => entry.split('=') as [string, string]),
  );
  const baseNames = surface === 'public' ? PUBLIC_ENVIRONMENT_NAMES : HOST_ENVIRONMENT_NAMES;
  const requiredEnvironmentNames = [...new Set([...baseNames, ...additionalNames])].map(
    (name) => aliases[name] ?? name,
  );
  const missingEnvironmentNames = requiredEnvironmentNames.filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
  const serviceUrlName = aliases.NOODLE_SERVICE_URL ?? 'NOODLE_SERVICE_URL';
  const csp = inspectNextCsp(
    dir,
    env[serviceUrlName],
    cspDirectivesFor(surface, dir),
    serviceUrlName,
    framework === 'django-vue' ? DJANGO_CSP_FILES : NEXT_CSP_FILES,
  );
  const diagnostics = inspectHostDiagnostics(dir, surface, env[serviceUrlName], framework);
  const detectedRisk = [
    diagnostics.serviceUrl.status,
    diagnostics.sessionRoute.status,
    diagnostics.clientMount.status,
    diagnostics.sessionCookies.status,
  ].some((status) =>
    ['invalid', 'mcp-endpoint', 'html-redirect-risk', 'ssr-risk', 'cross-origin-risk'].includes(
      status,
    ),
  );
  const ready =
    missingEnvironmentNames.length === 0 &&
    (csp.status === 'ready' || csp.status === 'not-detected') &&
    !detectedRisk;
  const diagnosticStatuses = [
    diagnostics.serviceUrl.status,
    diagnostics.sessionRoute.status,
    diagnostics.clientMount.status,
    diagnostics.sessionCookies.status,
  ];
  const staticStatus = !ready
    ? 'failed'
    : diagnosticStatuses.some((status) => status === 'not-detected' || status === 'unverified')
      ? 'partial'
      : 'passed';
  const evidence = {
    provenThrough: staticStatus === 'passed' ? 'static-host' : null,
    firstUnproven: staticStatus === 'passed' ? 'local-contract' : 'static-host',
    levels: EVIDENCE_LEVELS.map((id) => ({
      id,
      status: id === 'static-host' ? staticStatus : 'unproven',
    })),
  };
  const report = {
    framework,
    dir,
    ready,
    surface,
    requiredEnvironmentNames,
    missingEnvironmentNames,
    csp,
    diagnostics,
    evidence,
    postDeployProbes: postDeployProbes(surface),
  };

  if (json) printJsonOk(report);
  else {
    console.log(
      ready
        ? 'Assistant host has no detected static blockers.'
        : 'Assistant host static checks need attention.',
    );
    console.log(
      missingEnvironmentNames.length === 0
        ? '  PASS  required host environment names are present'
        : `  FAIL  missing host environment: ${missingEnvironmentNames.join(', ')}`,
    );
    console.log(
      `  ${csp.status === 'ready' || csp.status === 'not-detected' ? 'PASS' : 'FAIL'}  host CSP: ${csp.status}`,
    );
    if (csp.fix) console.log(`        ${csp.fix}`);
    console.log(`  EVIDENCE  first unproven level: ${evidence.firstUnproven}`);
    console.log('        Static success is not local-contract or production-browser proof.');
  }
  return ready ? EXIT.OK : EXIT.FAILURE;
}

function inspectNextCsp(
  dir: string,
  serviceUrl: string | undefined,
  directives: readonly string[],
  serviceUrlName: string,
  candidates: readonly string[],
): HostCspCheck {
  const found = candidates.flatMap((path) => {
    const full = join(dir, path);
    if (!existsSync(full)) return [];
    return [{ path, content: readFileSync(full, 'utf8') }];
  });
  const cspFiles = found.filter(({ content }) =>
    /content-security-policy|connect-src|frame-src|script-src/i.test(content),
  );
  if (cspFiles.length === 0) return { status: 'not-detected', files: [] };

  const combined = cspFiles.map(({ content }) => content).join('\n');
  const missingDirectives = directives.filter(
    (directive) => !new RegExp(`\\b${directive}\\b`, 'i').test(combined),
  );
  const files = cspFiles.map(({ path }) => path);
  if (missingDirectives.length > 0) {
    return {
      status: 'missing-directives',
      files,
      missingDirectives,
      fix: `Add ${missingDirectives.join(' and ')} for the ${serviceUrlName} origin.`,
    };
  }

  const serviceOrigin = parseOrigin(serviceUrl);
  if (serviceOrigin === undefined || !cspCoversOrigin(combined, serviceOrigin, serviceUrlName)) {
    return {
      status: 'unverified',
      files,
      fix: `Make the directives statically reference the ${serviceUrlName} origin (an exact origin or a covering wildcard such as https://*.example.com), or verify the generated production header before merge.`,
    };
  }
  return { status: 'ready', files };
}

function inspectHostDiagnostics(
  dir: string,
  surface: HostSurface,
  serviceUrl: string | undefined,
  framework: string,
): HostDiagnostics {
  const serviceUrlCheck = inspectServiceUrl(serviceUrl);
  const routeFiles = readExistingFiles(
    dir,
    framework === 'django-vue' ? DJANGO_SESSION_FILES : NEXT_SESSION_ROUTE_FILES,
  );
  const mountFiles = readExistingFiles(
    dir,
    framework === 'django-vue' ? VUE_CLIENT_FILES : NEXT_CLIENT_MOUNT_FILES,
  );
  const authenticated = surface !== 'public';

  const sessionRoute: HostDiagnostic & { readonly files: readonly string[] } = authenticated
    ? inspectSessionRoute(routeFiles)
    : { status: 'not-applicable', files: [] };
  const clientMount = inspectClientMount(mountFiles);
  const sessionCookies: HostDiagnostic & { readonly files: readonly string[] } = authenticated
    ? inspectSessionCookies(mountFiles)
    : { status: 'not-applicable', files: [] };

  return {
    serviceUrl: serviceUrlCheck,
    sessionRoute,
    clientMount,
    sessionCookies,
  };
}

function inspectServiceUrl(value: string | undefined): HostDiagnostic {
  if (!value) return { status: 'missing' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { status: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { status: 'invalid' };
  const path = url.pathname.replace(/\/+$/, '');
  if (/(?:^|\/)mcp$/i.test(path)) return { status: 'mcp-endpoint' };
  return { status: 'ready' };
}

function readExistingFiles(
  dir: string,
  candidates: readonly string[],
): Array<{ readonly path: string; readonly content: string }> {
  return candidates.flatMap((path) => {
    const full = join(dir, path);
    return existsSync(full) ? [{ path, content: readFileSync(full, 'utf8') }] : [];
  });
}

function inspectSessionRoute(
  files: readonly { readonly path: string; readonly content: string }[],
): HostDiagnostic & { readonly files: readonly string[] } {
  const paths = files.map(({ path }) => path);
  if (files.length === 0) return { status: 'not-detected', files: [] };
  const source = files.map(({ content }) => content).join('\n');
  if (
    /\b(?:redirect|permanentRedirect|notFound)\s*\(/.test(source) ||
    /\b(?:Response|NextResponse)\.redirect\s*\(/.test(source)
  ) {
    return { status: 'html-redirect-risk', files: paths };
  }
  const maintainedHandler =
    /import\s*\{\s*createAssistantSessionHandler\s*\}\s*from\s*['"]@noodleseed\/assistant\/server['"]/.test(
      source,
    ) && /export\s+const\s+POST\s*=\s*createAssistantSessionHandler\s*\(/.test(source);
  return maintainedHandler ||
    /\b(?:Response|NextResponse)\.json\s*\(|\bJsonResponse\s*\(/.test(source)
    ? { status: 'ready', files: paths }
    : { status: 'unverified', files: paths };
}

function inspectClientMount(
  files: readonly { readonly path: string; readonly content: string }[],
): HostDiagnostic & { readonly files: readonly string[] } {
  const paths = files.map(({ path }) => path);
  if (files.length === 0) return { status: 'not-detected', files: [] };
  const source = files.map(({ content }) => content).join('\n');
  const clientOnly =
    (/['"]use client['"]/.test(source) && /\bssr\s*:\s*false\b/.test(source)) ||
    (paths.every((path) => path.endsWith('.vue')) && /\bonMounted\s*\(/.test(source));
  return clientOnly ? { status: 'ready', files: paths } : { status: 'ssr-risk', files: paths };
}

/** Proves a statically visible root-relative endpoint stays same-origin after URL normalization. */
function inspectSessionCookies(
  files: readonly { readonly path: string; readonly content: string }[],
): HostDiagnostic & { readonly files: readonly string[] } {
  const paths = files.map(({ path }) => path);
  if (files.length === 0) return { status: 'not-detected', files: [] };
  const source = files.map(({ content }) => content).join('\n');
  const sessionEndpoint = source.match(/sessionEndpoint\s*=\s*["']([^"']+)["']/)?.[1];
  if (sessionEndpoint === undefined) return { status: 'unverified', files: paths };
  const hasControlCharacter = Array.from(sessionEndpoint).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
  const isCanonicalRootRelative = /^\/(?![\\/])/.test(sessionEndpoint) && !hasControlCharacter;
  if (!isCanonicalRootRelative) return { status: 'cross-origin-risk', files: paths };
  const sameOriginBase = new URL('https://assistant-host.invalid/');
  let resolvedEndpoint: URL;
  try {
    resolvedEndpoint = new URL(sessionEndpoint, sameOriginBase);
  } catch {
    return { status: 'cross-origin-risk', files: paths };
  }
  return resolvedEndpoint.origin === sameOriginBase.origin
    ? { status: 'ready', files: paths }
    : { status: 'cross-origin-risk', files: paths };
}

/**
 * Whether the statically visible CSP text names the service origin: exactly, via the env
 * placeholder, or through a covering wildcard source. A correct wildcard
 * (`https://*.noodleseed.dev` for `https://api.noodleseed.dev`) must verify — the literal
 * substring match used to fail it while an app with no CSP at all passed, which inverted the
 * check's whole point. Scheme must match, and per CSP semantics `*.suffix` covers subdomains
 * of `suffix`, never `suffix` itself.
 */
function cspCoversOrigin(combined: string, origin: string, placeholder: string): boolean {
  if (combined.includes(origin) || combined.includes(placeholder)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const wildcardSources = combined.match(/https?:\/\/\*[^\s"'`;,)]*/g) ?? [];
  return wildcardSources.some((source) => {
    const scheme = source.startsWith('https://') ? 'https:' : 'http:';
    if (scheme !== url.protocol) return false;
    const host = source.slice(source.indexOf('//') + 2);
    if (!host.startsWith('*.')) return false;
    const suffix = host.slice(2).split('/')[0]?.split(':')[0];
    return suffix !== undefined && suffix.length > 0 && url.hostname.endsWith(`.${suffix}`);
  });
}

function flagCount(args: readonly string[], flag: string): number {
  return args.filter((arg) => arg === flag).length;
}

function parseOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined)
      values.push(args[index + 1] as string);
  }
  return values;
}

function hasFlagWithoutValue(args: readonly string[], flag: string): boolean {
  return args.some(
    (arg, index) =>
      arg === flag && (args[index + 1] === undefined || args[index + 1]?.startsWith('--')),
  );
}
