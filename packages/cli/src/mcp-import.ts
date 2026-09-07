import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffSnapshots,
  type McpImportAuth,
  type McpImportSnapshot,
  parseMcpImportSnapshot,
  probeMcpServer,
  renderMcpServerSource,
} from '@noodle-borg/openapi-import';
import { slug } from './deploy.js';
import { importedProjectFiles, writeImportedProject } from './import-scaffold.js';

const SNAPSHOT_PATH = join('.noodle', 'mcp-import.json');
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface McpImportDependencies {
  readonly probe?: typeof probeMcpServer;
}

export interface ImportMcpProjectOptions {
  readonly endpoint: string;
  readonly output: string;
  readonly name: string;
  readonly prefix?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: McpImportAuth;
  readonly force?: boolean;
}

export async function importMcpProject(
  options: ImportMcpProjectOptions,
  dependencies: McpImportDependencies = {},
): Promise<{
  readonly output: string;
  readonly snapshot: McpImportSnapshot;
}> {
  const entrypoint = join(options.output, 'src/server.ts');
  if (existsSync(entrypoint) && options.force !== true) {
    throw new Error(`refusing to overwrite ${entrypoint}; pass --force to replace it`);
  }
  const snapshot = await (dependencies.probe ?? probeMcpServer)({
    endpoint: options.endpoint,
    name: options.name,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
  });
  const files = importedProjectFiles(slug(options.name), renderMcpServerSource(snapshot));
  files[SNAPSHOT_PATH] = `${JSON.stringify(snapshot, null, 2)}\n`;
  files['README.md'] = readme(snapshot);
  files['.env.example'] += `${snapshot.endpointVariable}=\n${snapshot.originVariable}=\n`;
  if (snapshot.auth !== undefined) files['.env.example'] += `${snapshot.auth.secretRef}=\n`;
  writeImportedProject({ dir: options.output, force: options.force ?? false }, files);
  return { output: options.output, snapshot };
}

export async function checkMcpProject(
  options: Omit<ImportMcpProjectOptions, 'force'>,
  dependencies: McpImportDependencies = {},
): Promise<{
  readonly changed: boolean;
  readonly lines: readonly string[];
}> {
  const before = readSnapshot(join(options.output, SNAPSHOT_PATH));
  const after = await (dependencies.probe ?? probeMcpServer)({
    endpoint: options.endpoint,
    name: before.connectorId,
    ...((options.prefix ?? before.prefix) === undefined
      ? {}
      : { prefix: options.prefix ?? before.prefix }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(before.auth === undefined ? {} : { auth: before.auth }),
  });
  return diffSnapshots(before, after);
}

function readSnapshot(path: string): McpImportSnapshot {
  if (statSync(path).size > MAX_SNAPSHOT_BYTES) {
    throw new Error('MCP import snapshot exceeds the size limit; re-run the import command');
  }
  try {
    return parseMcpImportSnapshot(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error('MCP import snapshot is invalid; re-run the import command');
  }
}

function readme(snapshot: McpImportSnapshot): string {
  const secret =
    snapshot.auth === undefined
      ? ''
      : `\n\`\`\`sh\nnoodle secrets set ${snapshot.auth.secretRef}\n\`\`\`\n`;
  return `# ${title(snapshot.connectorId)}

Generated from a frozen upstream MCP tool snapshot. Runtime calls only the tools declared in
\`src/server.ts\`; re-run \`noodle import mcp ... --check\` to review upstream drift.

This command writes files only. Run \`npm install --ignore-scripts\`, then \`npm run agent:check\`
and \`npm exec -- noodle agents setup --apply\` inside this directory. The generated test compiles
the offline contract; it does not call upstream tools or prove live behavior.

Upstream annotations are untrusted hints. Every generated tool starts as a destructive confirmed
action. Remove tools you do not intend to publish and change a tool to read-only only after verifying
the upstream behavior.

Copy declared names from \`.env.example\` into ignored \`.env\` or \`.env.noodle\` for local
development. Bind this same source to each customer store through hosted operator-managed values:

\`\`\`sh
noodle variables set ${snapshot.endpointVariable} <store-mcp-url>
noodle variables set ${snapshot.originVariable} <store-origin>
\`\`\`
${secret}
Then validate and run locally:

\`\`\`sh
noodle validate
noodle test
noodle dev
\`\`\`
`;
}

function title(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
