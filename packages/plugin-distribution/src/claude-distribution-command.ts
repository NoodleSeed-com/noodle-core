import {
  type HostPackageAssetInput,
  type HostPackageResult,
  skillSlug,
} from '@noodle-borg/agent-packaging';
import { packageAnthropicConnector } from './anthropic-connector.js';
import { packageClaudePlugin } from './claude-plugin.js';
import {
  type DistributionArchiveWriter,
  type DistributionCompileIssue,
  type DistributionCompiler,
  readDistributionAssets,
  writeDistributionArchiveAtomically,
} from './distribution-command-support.js';

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
  readonly fix?: string;
  readonly next?: string;
  readonly errors?: readonly DistributionCompileIssue[];
}

interface ParsedFlags {
  readonly positional: readonly string[];
  readonly mcpUrl?: string;
  readonly output?: string;
  readonly connectorsPath?: string;
  readonly auth?: string;
  readonly categories: readonly string[];
  readonly json: boolean;
  readonly parseError?: string;
}

interface MutableParsedFlags {
  positional: string[];
  mcpUrl?: string;
  output?: string;
  connectorsPath?: string;
  auth?: string;
  categories: string[];
  json: boolean;
  parseError?: string;
}

export type ClaudeDistributionCompiler = DistributionCompiler;
export type ClaudeDistributionArchiveWriter = DistributionArchiveWriter;

export async function runExportClaudePlugin(
  rest: readonly string[],
  compileLocalInput: ClaudeDistributionCompiler,
  resolveLocalEntrypoint: () => string | undefined,
  writeArchive: ClaudeDistributionArchiveWriter = (outputPath, bytes) =>
    writeDistributionArchiveAtomically(outputPath, bytes, 'claude-plugin'),
): Promise<number> {
  const parsed = parseFlags(rest, 'plugin');
  const json = parsed.json;
  if (parsed.parseError !== undefined) {
    return usageFailure(parsed.parseError, 'plugin', json);
  }
  if (parsed.positional.length > 1) {
    return usageFailure(
      'export plugin claude accepts at most one server.ts entrypoint',
      'plugin',
      json,
    );
  }
  if (parsed.mcpUrl === undefined) {
    return usageFailure('export plugin claude requires --mcp-url', 'plugin', json);
  }
  if (parsed.output === undefined) {
    return usageFailure('export plugin claude requires --output', 'plugin', json);
  }
  const prepared = await preparePackage(
    parsed,
    compileLocalInput,
    resolveLocalEntrypoint,
    'plugin',
    json,
  );
  if (typeof prepared === 'number') return prepared;

  const result = packageClaudePlugin({
    appPackage: prepared.appPackage,
    distribution: prepared.distribution,
    mcpServer: { url: parsed.mcpUrl, transport: 'streamable-http' },
    assets: prepared.assets,
  });
  return finishPackage(
    result,
    parsed.output,
    prepared.appPackage.app.name,
    prepared.appPackage.app.version,
    writeArchive,
    {
      commandKind: 'plugin',
      label: 'Claude plugin',
      invalidCode: 'claude_plugin_invalid',
      writeCode: 'claude_plugin_write_failed',
      json,
    },
  );
}

export async function runExportAnthropicConnector(
  rest: readonly string[],
  compileLocalInput: ClaudeDistributionCompiler,
  resolveLocalEntrypoint: () => string | undefined,
  writeArchive: ClaudeDistributionArchiveWriter = (outputPath, bytes) =>
    writeDistributionArchiveAtomically(outputPath, bytes, 'anthropic-connector'),
): Promise<number> {
  const parsed = parseFlags(rest, 'connector');
  const json = parsed.json;
  if (parsed.parseError !== undefined) {
    return usageFailure(parsed.parseError, 'connector', json);
  }
  if (parsed.positional.length > 1) {
    return usageFailure(
      'export connector claude accepts at most one server.ts entrypoint',
      'connector',
      json,
    );
  }
  if (parsed.mcpUrl === undefined) {
    return usageFailure('export connector claude requires --mcp-url', 'connector', json);
  }
  if (parsed.auth !== 'none' && parsed.auth !== 'oauth-dcr') {
    return usageFailure(
      'export connector claude requires --auth none or oauth-dcr',
      'connector',
      json,
    );
  }
  if (parsed.categories.length === 0) {
    return usageFailure(
      'export connector claude requires at least one --category',
      'connector',
      json,
    );
  }
  if (parsed.output === undefined) {
    return usageFailure('export connector claude requires --output', 'connector', json);
  }
  const prepared = await preparePackage(
    parsed,
    compileLocalInput,
    resolveLocalEntrypoint,
    'connector',
    json,
  );
  if (typeof prepared === 'number') return prepared;
  const allowedLinks = prepared.allowedLinks;
  const result = packageAnthropicConnector(
    {
      appPackage: prepared.appPackage,
      distribution: prepared.distribution,
      mcpServer: { url: parsed.mcpUrl, transport: 'streamable-http' },
      assets: prepared.assets,
    },
    { auth: parsed.auth, categories: parsed.categories, allowedLinks },
  );
  return finishPackage(
    result,
    parsed.output,
    prepared.appPackage.app.name,
    prepared.appPackage.app.version,
    writeArchive,
    {
      commandKind: 'connector',
      label: 'Anthropic connector dossier',
      invalidCode: 'anthropic_connector_invalid',
      writeCode: 'anthropic_connector_write_failed',
      json,
    },
  );
}

async function preparePackage(
  parsed: ParsedFlags,
  compileLocalInput: ClaudeDistributionCompiler,
  resolveLocalEntrypoint: () => string | undefined,
  kind: 'plugin' | 'connector',
  json: boolean,
): Promise<PreparedPackage | number> {
  const command = `export ${kind} claude`;
  const entrypoint = parsed.positional[0] ?? resolveLocalEntrypoint();
  if (entrypoint === undefined) return missingProjectEntrypoint(command, json);
  const compiled = await compileLocalInput({
    manifestPath: entrypoint,
    ...(parsed.connectorsPath === undefined ? {} : { connectorsPath: parsed.connectorsPath }),
  });
  if (!compiled.ok) {
    return failure(
      {
        code: `claude_${kind}_compile_failed`,
        message: `The Claude ${kind} could not be exported because local compilation failed.`,
        fix: 'Fix the structured compiler errors, then export again.',
        next: 'noodle validate --json',
        errors: compiled.errors,
      },
      json,
    );
  }
  if (compiled.compiled.appPackage === undefined || compiled.distribution === undefined) {
    return failure(
      {
        code: `claude_${kind}_unavailable`,
        message: `Claude ${kind} export requires both agentGuide and distribution in server.ts.`,
        fix: 'Add a product agent guide and host-neutral distribution metadata, then validate.',
        next: 'noodle validate --json',
      },
      json,
    );
  }
  let assets: readonly HostPackageAssetInput[];
  try {
    assets = readDistributionAssets(compiled.distribution, compiled.rootDir);
  } catch {
    return failure(
      {
        code: `claude_${kind}_assets_invalid`,
        message: `The Claude ${kind} assets could not be read safely.`,
        fix: 'Use existing project-relative image files declared through asset(...), then retry.',
        next: 'noodle validate --json',
      },
      json,
    );
  }
  return {
    appPackage: compiled.compiled.appPackage,
    distribution: compiled.distribution,
    assets,
    allowedLinks: [...(compiled.compiled.artifact?.server.handoff?.allowedDomains ?? [])].sort(
      compare,
    ),
  };
}

interface PreparedPackage {
  readonly appPackage: NonNullable<
    Extract<
      Awaited<ReturnType<DistributionCompiler>>,
      { readonly ok: true }
    >['compiled']['appPackage']
  >;
  readonly distribution: NonNullable<
    Extract<Awaited<ReturnType<DistributionCompiler>>, { readonly ok: true }>['distribution']
  >;
  readonly assets: readonly HostPackageAssetInput[];
  readonly allowedLinks: readonly string[];
}

function finishPackage(
  result: HostPackageResult,
  output: string,
  appName: string,
  version: string,
  writeArchive: ClaudeDistributionArchiveWriter,
  options: {
    readonly commandKind: 'plugin' | 'connector';
    readonly label: string;
    readonly invalidCode: string;
    readonly writeCode: string;
    readonly json: boolean;
  },
): number {
  const command = `noodle export ${options.commandKind} claude --help`;
  if (!result.ok) {
    return failure(
      {
        code: options.invalidCode,
        message: `The ${options.label} target rejected this package.`,
        fix: 'Resolve each target issue in server.ts or the export options, then retry.',
        next: command,
        errors: result.issues.map(({ code, path, message }) => ({ code, path, message })),
      },
      options.json,
    );
  }
  try {
    writeArchive(output, result.archive.bytes);
  } catch {
    return failure(
      {
        code: options.writeCode,
        message: `The ${options.label} archive could not be written.`,
        fix: 'Choose a writable output path and try again.',
        next: command,
      },
      options.json,
    );
  }
  const data = {
    target: result.target,
    app: {
      name: skillSlug(appName),
      version,
    },
    output,
    treeSha256: result.treeSha256,
    archiveSha256: result.archive.sha256,
    byteLength: result.archive.byteLength,
    files: result.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  };
  if (options.json) printJsonOk(data);
  else {
    console.log(`Wrote ${options.label} to ${output}`);
    console.log(`Archive SHA-256: ${result.archive.sha256}`);
  }
  return EXIT.OK;
}

function parseFlags(rest: readonly string[], kind: 'plugin' | 'connector'): ParsedFlags {
  const parsed: MutableParsedFlags = { positional: [], categories: [], json: false };
  const setters: Readonly<Record<string, (value: string) => void>> = {
    '--mcp-url': (value) => {
      parsed.mcpUrl = value;
    },
    '--output': (value) => {
      parsed.output = value;
    },
    '--connectors': (value) => {
      parsed.connectorsPath = value;
    },
    ...(kind === 'connector'
      ? {
          '--auth': (value: string) => {
            parsed.auth = value;
          },
          '--category': (value: string) => {
            parsed.categories.push(value);
          },
        }
      : {}),
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    const setValue = setters[arg];
    if (setValue !== undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        parsed.parseError ??= `${arg} requires a value`;
      } else {
        setValue(value);
        index++;
      }
      continue;
    }
    if (arg.startsWith('-')) parsed.parseError ??= `unknown option: ${arg}`;
    else parsed.positional.push(arg);
  }
  return parsed;
}

function usageFailure(message: string, kind: 'plugin' | 'connector', json: boolean): number {
  const error = {
    code: 'usage_error',
    message,
    fix: `Pass the required Claude ${kind} options.`,
    next: `noodle export ${kind} claude --help`,
  };
  if (json) return printJsonFailure(error, EXIT.USAGE);
  console.error(message);
  return EXIT.USAGE;
}

function missingProjectEntrypoint(command: string, json: boolean): number {
  const error = {
    code: 'project_entrypoint_required',
    message: 'No project entrypoint found.',
    cause: 'No project entrypoint found.',
    fix: 'Create a project or bind this directory to an existing project entrypoint.',
    next: 'noodle init or noodle link --entrypoint <path>',
  };
  if (json) return printJsonFailure(error, EXIT.USAGE);
  console.error(`${command}: ${error.message}`);
  console.error(`Cause: ${error.cause}`);
  console.error(`Fix: ${error.fix}`);
  console.error(`Next: ${error.next}`);
  return EXIT.USAGE;
}

function failure(error: CommandError, json: boolean): number {
  if (json) return printJsonFailure(error, EXIT.FAILURE);
  console.error(error.message);
  if (error.fix !== undefined) console.error(`Fix: ${error.fix}`);
  return EXIT.FAILURE;
}

function printJsonOk(data: unknown): void {
  console.log(JSON.stringify({ ok: true, data }));
}

function printJsonFailure(error: CommandError, exitCode: number): number {
  console.log(JSON.stringify({ ok: false, error }));
  return exitCode;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
