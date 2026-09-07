import type { McpImportAuth } from '@noodle-borg/openapi-import';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { checkMcpProject, importMcpProject, type McpImportDependencies } from '../mcp-import.js';
import { importOpenApiProject } from '../openapi-import.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';

/** Import an OpenAPI document or a frozen, explicitly reviewed upstream MCP tool snapshot. */
export async function runImport(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  mcpDependencies: McpImportDependencies = {},
): Promise<number> {
  const [kind, source, ...tail] = rest;
  const json = rest.includes('--json');
  if ((kind !== 'openapi' && kind !== 'mcp') || source === undefined || source.startsWith('--')) {
    if (json) {
      return printJsonFailure(
        {
          code: 'invalid_import_options',
          message: 'The import kind and source are required.',
          fix: 'Provide an OpenAPI file or an MCP endpoint URL.',
          next: 'noodle import mcp <url> --json',
        },
        EXIT.USAGE,
      );
    }
    console.error(
      'import: use noodle import openapi <file> or noodle import mcp <url> [--name <slug>] [--output <dir>]',
    );
    return EXIT.USAGE;
  }
  let output = kind === 'mcp' ? 'noodle-mcp-app' : 'noodle-openapi-app';
  let name = kind === 'mcp' ? 'mcp-app' : 'openapi-app';
  let baseUrl: string | undefined;
  let prefix: string | undefined;
  let headerEnv: string | undefined;
  let force = false;
  let check = false;
  let parseError: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    const nextValue = (): string | undefined => {
      const candidate = tail[i + 1];
      if (candidate === undefined || candidate.startsWith('--')) {
        parseError = `${arg} requires a value`;
        return undefined;
      }
      i += 1;
      return candidate;
    };
    if (arg === '--output') output = nextValue() ?? output;
    else if (arg === '--name') name = nextValue() ?? name;
    else if (arg === '--base-url') baseUrl = nextValue();
    else if (arg === '--prefix') prefix = nextValue();
    else if (arg === '--header-env') headerEnv = nextValue();
    else if (arg === '--force') force = true;
    else if (arg === '--check') check = true;
    else if (arg === '--json') continue;
    else parseError = `unknown import option: ${arg}`;
    if (parseError !== undefined) break;
  }
  if (parseError === undefined && kind === 'mcp' && baseUrl !== undefined) {
    parseError = '--base-url applies only to OpenAPI imports';
  }
  if (
    parseError === undefined &&
    kind === 'openapi' &&
    (prefix !== undefined || headerEnv !== undefined || check)
  ) {
    parseError = '--prefix, --header-env, and --check apply only to MCP imports';
  }
  if (parseError === undefined && check && force) {
    parseError = '--check cannot be combined with --force';
  }
  if (parseError !== undefined) {
    if (json) {
      return printJsonFailure(
        {
          code: 'invalid_import_options',
          message: parseError,
          fix: 'Use only options supported by the selected import kind.',
          next: `noodle import ${kind} --help`,
        },
        EXIT.USAGE,
      );
    }
    console.error(`import: ${parseError}`);
    return EXIT.USAGE;
  }
  try {
    if (kind === 'mcp') {
      const header = mcpImportHeader(headerEnv, env);
      const common = {
        endpoint: source,
        output,
        name,
        ...(prefix === undefined ? {} : { prefix }),
        ...(header === undefined ? {} : { headers: header.headers, auth: header.auth }),
      };
      if (check) {
        const result = await checkMcpProject(common, mcpDependencies);
        if (json) {
          if (result.changed) {
            return printJsonFailure(
              {
                code: 'mcp_snapshot_drift',
                message: 'The upstream MCP tool snapshot changed.',
                errors: result.lines.map((message) => ({ code: 'mcp_snapshot_drift', message })),
                fix: 'Review the diff, then re-run the import without --check to accept it.',
                next: `noodle import mcp ${source} --output ${output} --force`,
              },
              EXIT.FAILURE,
            );
          }
          printJsonOk({ changed: false, lines: [], output });
          return EXIT.OK;
        }
        if (result.changed) {
          console.error('Upstream MCP snapshot changed:');
          for (const line of result.lines) console.error(`- ${line}`);
          return EXIT.FAILURE;
        }
        console.log('Upstream MCP snapshot is unchanged.');
        return EXIT.OK;
      }
      const result = await importMcpProject({ ...common, force }, mcpDependencies);
      if (json) {
        printJsonOk(
          { output: result.output, toolCount: result.snapshot.tools.length },
          result.snapshot.warnings,
        );
        return EXIT.OK;
      }
      console.log(`Imported ${result.snapshot.tools.length} frozen MCP tools in ${result.output}`);
      for (const warning of result.snapshot.warnings) console.log(`warning: ${warning}`);
      console.log('Next: noodle validate');
      return EXIT.OK;
    }
    const result = importOpenApiProject({
      specPath: source,
      output,
      name,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      force,
    });
    if (json) {
      printJsonOk({ output: result.output }, result.warnings);
      return EXIT.OK;
    }
    console.log(`Imported OpenAPI project in ${result.output}`);
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
    console.log('Next: noodle validate');
    return EXIT.OK;
  } catch (error) {
    if (json) {
      return printJsonFailure(
        {
          code: kind === 'mcp' ? 'mcp_import_failed' : 'openapi_import_failed',
          message: `${kind} import failed`,
          cause: errorMessage(error),
          fix:
            kind === 'mcp'
              ? 'Check the endpoint, import credential environment, and upstream MCP schemas.'
              : 'Check the OpenAPI file and pass --base-url if the document has no server URL.',
          next:
            kind === 'mcp'
              ? 'noodle import mcp <url> --name <slug>'
              : 'noodle import openapi <file>',
        },
        EXIT.FAILURE,
      );
    }
    printRecovery({
      command: `import ${kind}`,
      cause: errorMessage(error),
      fix:
        kind === 'mcp'
          ? 'Check the endpoint, import credential environment, and upstream MCP schemas.'
          : 'Check the OpenAPI file and pass --base-url if the document has no server URL.',
      next:
        kind === 'mcp'
          ? 'noodle import mcp <url> --name <slug>'
          : 'noodle import openapi <file> --base-url <url>',
    });
    return EXIT.FAILURE;
  }
}

function mcpImportHeader(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): { readonly headers: Record<string, string>; readonly auth: McpImportAuth } | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf('=');
  const name = value.slice(0, separator).trim();
  const envName = value.slice(separator + 1).trim();
  if (
    separator < 1 ||
    !/^[A-Za-z0-9_-]+$/.test(name) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)
  ) {
    throw new Error('--header-env must be <header-name>=<ENV_NAME>');
  }
  const secretValue = env[envName];
  if (secretValue === undefined || secretValue.length === 0) {
    throw new Error(`environment variable ${envName} is unavailable`);
  }
  if (secretValue.length > 8_192 || /[\r\n]/.test(secretValue)) {
    throw new Error(`environment variable ${envName} is not a valid header value`);
  }
  if (name.toLowerCase() === 'authorization') {
    return {
      headers: { authorization: `Bearer ${secretValue}` },
      auth: { kind: 'bearer', secretRef: envName },
    };
  }
  return {
    headers: { [name]: secretValue },
    auth: { kind: 'apiKey', header: name, secretRef: envName },
  };
}
