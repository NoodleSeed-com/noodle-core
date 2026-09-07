import { readFileSync } from 'node:fs';
import { type DistributionMetadataV1, noodlePlatformCatalog } from '@noodle-borg/authoring';
import {
  type CatalogConnector,
  type CompileResult,
  compile,
  InMemoryCatalog,
} from '@noodle-borg/compiler';
import { compileConnectors, type SecretBinding } from '@noodle-borg/connector-defs';
import { readDeployInput } from './deploy.js';

interface LocalCompileIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly didYouMean?: string;
  readonly suggestions?: readonly string[];
  readonly expected?: string;
  readonly got?: string;
  readonly docAnchor?: string;
}

export type LocalCompileOutcome =
  | {
      readonly ok: true;
      readonly manifest: string;
      readonly rootDir: string;
      readonly distribution?: DistributionMetadataV1;
      readonly secretBindings: readonly SecretBinding[];
      readonly compiled: Extract<CompileResult, { readonly ok: true }>;
    }
  | {
      readonly ok: false;
      readonly stage: 'read' | 'connectors' | 'manifest';
      readonly errors: readonly LocalCompileIssue[];
    };

/** One account-free compiler path shared by validate and local App Package installation. */
export async function compileLocalInput(options: {
  readonly manifestPath: string;
  readonly connectorsPath?: string;
}): Promise<LocalCompileOutcome> {
  let manifest: string;
  let rootDir: string;
  let distribution: DistributionMetadataV1 | undefined;
  let connectors: string | undefined;
  try {
    const input = await readDeployInput(options.manifestPath);
    manifest = input.manifest;
    rootDir = input.rootDir;
    distribution = input.distribution;
    connectors =
      options.connectorsPath === undefined
        ? input.connectors
        : readFileSync(options.connectorsPath, 'utf8');
  } catch (cause) {
    return {
      ok: false,
      stage: 'read',
      errors: [{ code: 'read_error', path: '', message: (cause as Error).message }],
    };
  }

  const catalog: CatalogConnector[] = [];
  let secretBindings: readonly SecretBinding[] = [];
  if (connectors !== undefined && connectors.trim() !== '') {
    const compiledConnectors = compileConnectors(connectors);
    if (!compiledConnectors.ok) {
      return { ok: false, stage: 'connectors', errors: compiledConnectors.errors };
    }
    catalog.push(...compiledConnectors.catalog);
    secretBindings = compiledConnectors.secretBindings;
  }
  const compiled = compile(manifest, {
    catalog: new InMemoryCatalog([...noodlePlatformCatalog, ...catalog]),
    localAssets: { rootDir, publicOrigin: 'http://127.0.0.1' },
    knowledgeFiles: { rootDir },
  });
  if (!compiled.ok) return { ok: false, stage: 'manifest', errors: compiled.errors };
  return {
    ok: true,
    manifest,
    rootDir,
    ...(distribution === undefined ? {} : { distribution }),
    secretBindings,
    compiled,
  };
}
