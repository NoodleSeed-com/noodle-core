import { serviceJson } from '../control-plane.js';
import { readProjectDotenv } from '../project-dotenv.js';
import { confirm } from '../prompts.js';

interface DeployDotenvImportInput {
  readonly projectRoot: string;
  readonly missingSecrets: readonly string[];
  readonly missingVariables: readonly string[];
  readonly serviceUrl: string;
  readonly token: string;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
}

interface DeployDotenvImportDependencies {
  readonly confirmImport?: (message: string) => Promise<boolean>;
  readonly write?: (message: string) => void;
}

export interface DeployDotenvImportResult {
  readonly imported: boolean;
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

/**
 * Offer one target-specific import for missing, declared config names found in the project `.env`.
 * Values are never rendered; unrelated keys remain local and untouched.
 */
export async function promptToImportMissingDotenvConfig(
  input: DeployDotenvImportInput,
  dependencies: DeployDotenvImportDependencies = {},
): Promise<DeployDotenvImportResult> {
  const dotenv = readProjectDotenv(input.projectRoot);
  if (dotenv === undefined) return notImported();
  const secrets = input.missingSecrets.filter((name) => Object.hasOwn(dotenv.values, name));
  const variables = input.missingVariables.filter((name) => Object.hasOwn(dotenv.values, name));
  if (secrets.length === 0 && variables.length === 0) return notImported();

  const write = dependencies.write ?? ((message: string) => console.error(message));
  write(`Found matching .env values for ${targetLabel(input.target)}:`);
  for (const name of variables) write(`  variable ${name}`);
  for (const name of secrets) write(`  secret ${name}`);
  const confirmImport =
    dependencies.confirmImport ??
    ((message: string) => confirm(message, { initial: false, output: process.stderr }));
  if (!(await confirmImport(`Copy these .env values to ${targetLabel(input.target)}?`))) {
    return notImported();
  }

  for (const [kind, names] of [
    ['variable', variables],
    ['secret', secrets],
  ] as const) {
    for (const name of names) {
      await serviceJson(
        `${input.serviceUrl}/v1/orgs/${encodeURIComponent(input.target.org)}` +
          `/apps/${encodeURIComponent(input.target.app)}` +
          `/envs/${encodeURIComponent(input.target.env)}/${kind}s/${encodeURIComponent(name)}`,
        input.token,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: dotenv.values[name] }),
        },
      );
      write(`set ${kind} ${name} from .env`);
    }
  }
  return { imported: true, secrets, variables };
}

function targetLabel(target: {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}): string {
  return `${target.org}/${target.app}/${target.env}`;
}

function notImported(): DeployDotenvImportResult {
  return { imported: false, secrets: [], variables: [] };
}
