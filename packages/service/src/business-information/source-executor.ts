import {
  type ExprMap,
  type ExprNode,
  type ResolvedOperationRef,
  type RuntimeArtifact,
  sha256Canonical,
} from '@noodle-borg/compiler';
import { executeTool } from '@noodle-borg/runtime';
import type { RuntimeTargetResolver } from '../application-runtime-target.js';
import type { ServerRegistry } from '../registry.js';
import type { BusinessInformationStore } from './contracts.js';
import { privateDefinitionFromDeployment } from './definition-resolver.js';
import {
  type SourceCredentialAuthority,
  SourceCredentialError,
} from './source-credential-fence.js';
import type { SourceReadExecutor } from './source-ingestion-coordinator.js';
import { normalizeSourceFailureCode } from './source-ingestion-failures.js';
import { sourceOperationSignatureDigest } from './source-ingestion-validation.js';

const SOURCE_TOOL = '__collection_source_scan';

/** Executes a private definition's read-only source operation through the normal governed runtime. */
export class RegistrySourceReadExecutor implements SourceReadExecutor {
  readonly #registry: ServerRegistry;
  readonly #installations: BusinessInformationStore;
  readonly #resolveTarget: RuntimeTargetResolver;

  constructor(
    registry: ServerRegistry,
    installations: BusinessInformationStore,
    resolveTarget: RuntimeTargetResolver,
    readonly sourceAuthority?: SourceCredentialAuthority,
  ) {
    this.#registry = registry;
    this.#installations = installations;
    this.#resolveTarget = resolveTarget;
  }

  async scan(input: Parameters<SourceReadExecutor['scan']>[0]) {
    const installation = await this.#installations.getInstallation(input.binding.scope);
    if (installation?.definition.reference.kind !== 'private') {
      throw sourceFailure('source_definition_unavailable');
    }
    if (!installation.intakeActive) throw sourceFailure('source_application_paused');
    if (!installation.managedCollections.includes(input.binding.collectionKey)) {
      throw sourceFailure('source_operation_unavailable');
    }
    const reference = installation.definition.reference;
    if (installation.scope.org !== reference.publisherOrg) {
      throw sourceFailure('source_cross_org_binding_unavailable');
    }
    if (
      (await this.#registry.getAppArchivedAt(reference.publisherOrg, reference.app)) !== undefined
    ) {
      throw sourceFailure('source_app_archived');
    }
    // A private installation pins an immutable deployed artifact. A newer active deployment must not
    // disable source reads for customers still installed on the earlier, non-archived revision.
    const target = await this.#registry.get(reference.deploymentId);
    if (
      target === undefined ||
      target.org !== reference.publisherOrg ||
      target.app !== reference.app ||
      target.environment !== reference.env
    ) {
      throw sourceFailure('source_definition_unavailable');
    }
    const pinned = privateDefinitionFromDeployment(
      { ...reference, environment: reference.env },
      {
        ...target,
        deploymentId: reference.deploymentId,
        org: reference.publisherOrg,
        app: reference.app,
        environment: reference.env,
        artifact: target.served.artifact,
      },
    );
    if (pinned.reference.digest !== reference.digest) {
      throw sourceFailure('source_definition_drift');
    }
    const collection = target.served.artifact.server.managedCollections?.find(
      (candidate) => candidate.name === input.binding.collectionKey,
    );
    const source = collection?.source;
    if (
      !collection ||
      source === undefined ||
      source.authority !== 'external' ||
      !source.scan.resolved
    ) {
      throw sourceFailure('source_operation_unavailable');
    }
    assertExactOperation(source.scan, input.operation);
    assertConfiguredCredentialBinding(source.scan, input.binding);
    if (
      collection.schemaVersion !== input.binding.schemaVersion ||
      collection.schemaDigest.replace(/^sha256:/, '') !== input.binding.schemaDigest
    ) {
      throw sourceFailure('source_schema_drift');
    }
    // The immutable publisher artifact grants operation intent only. All executable dependencies,
    // operator values and credentials come from the currently activated installation tenant.
    const scope = installation.scope;
    const generation = await this.#registry.getAppGeneration(scope.org, scope.app);
    if (generation === undefined || generation !== installation.applicationGeneration)
      throw sourceFailure('source_installation_unavailable');
    const current = await this.#registry.getActiveByTenant(scope);
    const installed = current && (await this.#resolveTarget(current));
    if (
      !installed ||
      installed.org !== scope.org ||
      installed.app !== scope.app ||
      installed.environment !== scope.env ||
      !installed.deploymentId ||
      installed.deploymentId !== current?.deploymentId ||
      installed.served.deps.tenantId !== `${scope.org}/${scope.app}/${scope.env}` ||
      installed.served.deps.deploymentId !== installed.deploymentId
    ) {
      throw sourceFailure('source_installation_unavailable');
    }
    const installedCollection = installed.served.artifact.server.managedCollections?.find(
      (candidate) => candidate.name === collection.name,
    );
    if (
      !installedCollection ||
      sha256Canonical(installedCollection) !== sha256Canonical(collection)
    ) {
      throw sourceFailure('source_operation_drift');
    }
    // The live resolver pins this generation into broker acquisition. A revocation after this
    // comparison is still rejected by the broker, without holding a database lock during I/O.
    if (
      input.binding.credentialIdentity?.generation &&
      (!input.binding.bindingReference ||
        input.binding.credentialIdentity.generation !==
          installed.served.deps.executionBinding?.connections[input.binding.bindingReference])
    )
      throw sourceFailure('source_authorization_lost');
    const artifact = sourceArtifact(installed.served.artifact, source.scan, input.request);
    const check = () =>
      this.sourceAuthority?.withCurrent(input.binding, async (identity) => {
        if (
          sha256Canonical(identity ?? null) !==
          sha256Canonical(input.binding.credentialIdentity ?? null)
        )
          throw new SourceCredentialError();
      });
    await check();
    const deps = installed.served.deps;
    const result = await executeTool(
      artifact,
      SOURCE_TOOL,
      {},
      {
        ...deps,
        broker: {
          async getCredential(request) {
            const value = await deps.broker.getCredential(request);
            await check();
            return value;
          },
        },
      },
    );
    if (!result.ok) {
      const code =
        result.error.code === 'connector_error' && result.error.reason !== undefined
          ? normalizeSourceFailureCode(result.error.reason)
          : normalizeSourceFailureCode(result.error.code);
      throw sourceFailure(code);
    }
    return result.output as Awaited<ReturnType<SourceReadExecutor['scan']>>;
  }
}

function assertConfiguredCredentialBinding(
  operation: ResolvedOperationRef,
  binding: Parameters<SourceReadExecutor['scan']>[0]['binding'],
): void {
  const credential = operation.credentialBinding;
  if (
    credential === undefined ||
    binding.bindingReference !== credential.connectionId ||
    binding.configurationReference !== credential.connectionConfigRevision
  ) {
    throw sourceFailure('source_credential_binding_unavailable');
  }
}

function sourceArtifact(
  artifact: RuntimeArtifact,
  operationRef: ResolvedOperationRef,
  request: Parameters<SourceReadExecutor['scan']>[0]['request'],
): RuntimeArtifact {
  return {
    ...artifact,
    tools: [
      {
        name: SOURCE_TOOL,
        description: 'Internal read-only collection source scan.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        fulfilment: {
          kind: 'operation',
          operationRef,
          args: literalMap(request),
        },
      },
    ],
  };
}

function literalMap(value: object): ExprMap {
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, literal(item)]),
  );
}

function literal(value: unknown): ExprNode {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return { kind: 'literal', value };
  }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(literal) };
  if (typeof value === 'object' && value !== null) {
    return {
      kind: 'object',
      entries: Object.entries(value).map(([key, item]) => ({ key, value: literal(item) })),
    };
  }
  throw sourceFailure('source_request_invalid');
}

function assertExactOperation(
  operation: ResolvedOperationRef,
  expected: Parameters<SourceReadExecutor['scan']>[0]['operation'],
): void {
  if (
    operation.connectorId !== expected.connector ||
    operation.connectorVersion !== expected.connectorVersion ||
    operation.operation !== expected.operation ||
    sourceOperationSignatureDigest(operation.signatureHash) !== expected.signatureDigest
  ) {
    throw sourceFailure('source_operation_drift');
  }
}

function sourceFailure(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code });
}
