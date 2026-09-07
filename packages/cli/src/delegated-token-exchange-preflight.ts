import { noodlePlatformCatalog } from '@noodle-borg/authoring';
import { type CompileError, compile, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  type ConnectorCompileError,
  compileConnectors,
  delegatedTokenExchangeIdentityErrors,
} from '@noodle-borg/connector-defs';

/**
 * Compile the server side of the delegated-exchange identity invariant before direct deploy egress.
 * Invalid connector catalogs remain owned by the hosted compiler, but once a valid catalog declares token
 * exchange the local deploy must not trust raw object-shaped auth fields as proof of customer identity.
 */
export function delegatedTokenExchangeDeployErrors(input: {
  readonly manifest: string;
  readonly connectors: string | undefined;
  readonly rootDir: string;
}): readonly (CompileError | ConnectorCompileError)[] {
  if (input.connectors === undefined || input.connectors.trim() === '') return [];
  const connectors = compileConnectors(input.connectors);
  if (!connectors.ok) return [];
  if (!connectors.secretBindings.some((binding) => binding.authKind === 'delegatedTokenExchange')) {
    return [];
  }

  const compiled = compile(input.manifest, {
    catalog: new InMemoryCatalog([...noodlePlatformCatalog, ...connectors.catalog]),
    localAssets: { rootDir: input.rootDir, publicOrigin: 'http://127.0.0.1' },
    knowledgeFiles: { rootDir: input.rootDir },
  });
  if (!compiled.ok) return compiled.errors;
  return delegatedTokenExchangeIdentityErrors(connectors.secretBindings, compiled.artifact.server);
}
