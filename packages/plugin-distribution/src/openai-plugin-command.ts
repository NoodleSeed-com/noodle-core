import { type HostPackageAssetInput, skillSlug } from '@noodle-borg/agent-packaging';
import {
  type DistributionArchiveWriter,
  type DistributionCompileIssue,
  type DistributionCompiler,
  readDistributionAssets,
  writeDistributionArchiveAtomically,
} from './distribution-command-support.js';
import { type OpenAiPluginOptions, packageOpenAiPlugin } from './openai-plugin.js';

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

export type OpenAiPluginCompiler = DistributionCompiler;

export type OpenAiPluginArchiveWriter = DistributionArchiveWriter;

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
  readonly state?: string;
  readonly mcpUrl?: string;
  readonly category?: string;
  readonly registeredAppId?: string;
  readonly output?: string;
  readonly connectorsPath?: string;
  readonly json: boolean;
  readonly parseError?: string;
}

interface MutableParsedFlags {
  positional: string[];
  state?: string;
  mcpUrl?: string;
  category?: string;
  registeredAppId?: string;
  output?: string;
  connectorsPath?: string;
  json: boolean;
  parseError?: string;
}

export async function runExportOpenAiPlugin(
  rest: readonly string[],
  compileLocalInput: OpenAiPluginCompiler,
  resolveLocalEntrypoint: () => string | undefined,
  writeArchive: OpenAiPluginArchiveWriter = (outputPath, bytes) =>
    writeDistributionArchiveAtomically(outputPath, bytes, 'openai'),
): Promise<number> {
  const parsed = parseFlags(rest);
  const json = parsed.json;
  if (parsed.parseError !== undefined) return usageFailure(parsed.parseError, json);
  if (parsed.positional.length > 1) {
    return usageFailure('export plugin openai accepts at most one server.ts entrypoint', json);
  }
  if (parsed.state !== 'local' && parsed.state !== 'submission') {
    return usageFailure('export plugin openai requires --state local or submission', json);
  }
  if (parsed.mcpUrl === undefined) {
    return usageFailure('export plugin openai requires --mcp-url', json);
  }
  if (parsed.category === undefined) {
    return usageFailure('export plugin openai requires --category', json);
  }
  if (parsed.output === undefined) {
    return usageFailure('export plugin openai requires --output', json);
  }
  if (parsed.state === 'submission' && parsed.registeredAppId !== undefined) {
    return usageFailure('--registered-app-id is only valid with --state local', json);
  }
  const entrypoint = parsed.positional[0] ?? resolveLocalEntrypoint();
  if (entrypoint === undefined) return missingProjectEntrypoint(json);

  const compiled = await compileLocalInput({
    manifestPath: entrypoint,
    ...(parsed.connectorsPath === undefined ? {} : { connectorsPath: parsed.connectorsPath }),
  });
  if (!compiled.ok) {
    return failure(
      {
        code: 'openai_package_compile_failed',
        message: 'The OpenAI plugin could not be exported because local compilation failed.',
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
        code: 'openai_package_unavailable',
        message: 'OpenAI export requires both agentGuide and distribution in server.ts.',
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
        code: 'openai_package_assets_invalid',
        message: 'The OpenAI plugin assets could not be read safely.',
        fix: 'Use existing project-relative image files declared through asset(...), then retry.',
        next: 'noodle validate --json',
      },
      json,
    );
  }

  const options: OpenAiPluginOptions =
    parsed.state === 'submission'
      ? { state: 'submission', category: parsed.category }
      : {
          state: 'local',
          category: parsed.category,
          registeredAppId: parsed.registeredAppId ?? '',
        };
  const result = packageOpenAiPlugin(
    {
      appPackage: compiled.compiled.appPackage,
      distribution: compiled.distribution,
      mcpServer: { url: parsed.mcpUrl, transport: 'streamable-http' },
      assets,
    },
    options,
  );
  if (!result.ok) {
    return failure(
      {
        code: 'openai_package_invalid',
        message: 'The OpenAI target rejected this package.',
        fix: 'Resolve each target issue in server.ts or the export options, then retry.',
        next: 'noodle export plugin openai --help',
        errors: result.issues.map(({ code, path, message }) => ({ code, path, message })),
      },
      json,
    );
  }

  try {
    writeArchive(parsed.output, result.archive.bytes);
  } catch {
    return failure(
      {
        code: 'openai_package_write_failed',
        message: 'The OpenAI plugin archive could not be written.',
        fix: 'Choose a writable output path and try again.',
        next: 'noodle export plugin openai --help',
      },
      json,
    );
  }
  const appName = skillSlug(compiled.compiled.appPackage.app.name);
  const data = {
    target: result.target,
    state: parsed.state,
    app: {
      name: appName,
      version: compiled.compiled.appPackage.app.version,
    },
    output: parsed.output,
    ...(parsed.state === 'submission'
      ? {
          uploadArtifacts: {
            instructions: 'submission/README.md',
            submissionJson: 'submission/chatgpt-app-submission.json',
            skillZip: `submission/${appName}-skill.zip`,
          },
        }
      : {}),
    treeSha256: result.treeSha256,
    archiveSha256: result.archive.sha256,
    byteLength: result.archive.byteLength,
    files: result.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  };
  if (json) {
    printJsonOk(data);
  } else {
    console.log(
      parsed.state === 'submission'
        ? `Wrote OpenAI submission review kit to ${parsed.output}`
        : `Wrote OpenAI local plugin to ${parsed.output}`,
    );
    if (parsed.state === 'submission') {
      console.log('Extract the outer ZIP before uploading either portal artifact.');
      console.log('Submission JSON: submission/chatgpt-app-submission.json');
      console.log(`Skill ZIP: submission/${appName}-skill.zip`);
      console.log('Instructions: submission/README.md');
    }
    console.log(`Archive SHA-256: ${result.archive.sha256}`);
  }
  return EXIT.OK;
}

function parseFlags(rest: readonly string[]): ParsedFlags {
  const parsed: MutableParsedFlags = { positional: [], json: false };
  const valueSetters: Readonly<Record<string, (value: string) => void>> = {
    '--state': (value) => {
      parsed.state = value;
    },
    '--mcp-url': (value) => {
      parsed.mcpUrl = value;
    },
    '--category': (value) => {
      parsed.category = value;
    },
    '--registered-app-id': (value) => {
      parsed.registeredAppId = value;
    },
    '--output': (value) => {
      parsed.output = value;
    },
    '--connectors': (value) => {
      parsed.connectorsPath = value;
    },
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    const setValue = valueSetters[arg];
    if (setValue !== undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--'))
        parsed.parseError ??= `${arg} requires a value`;
      else {
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

function usageFailure(message: string, json: boolean): number {
  const error = {
    code: 'usage_error',
    message,
    fix: 'Pass the required OpenAI target options.',
    next: 'noodle export plugin openai --help',
  };
  if (json) return printJsonFailure(error, EXIT.USAGE);
  console.error(message);
  return EXIT.USAGE;
}

function missingProjectEntrypoint(json: boolean): number {
  const error = {
    code: 'project_entrypoint_required',
    message: 'No project entrypoint found.',
    cause: 'No project entrypoint found.',
    fix: 'Create a project or bind this directory to an existing project entrypoint.',
    next: 'noodle init or noodle link --entrypoint <path>',
  };
  if (json) return printJsonFailure(error, EXIT.USAGE);
  console.error(`export plugin openai: ${error.message}`);
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
