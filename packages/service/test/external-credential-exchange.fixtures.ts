import { createStaticSigningKeyProvider, type SigningKeyProvider } from '@noodle-borg/auth';
import {
  type ArtifactConnectorBinding,
  type CredentialProfile,
  computeConnectionConfigRevision,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import type { DnsLookup } from '@noodle-borg/connector-http';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import {
  type ExternalCredentialProviderConfig,
  type ExternalCredentialSubjectPinStore,
  InMemoryExternalCredentialProviderConfigStore,
  InMemoryExternalCredentialSubjectPinStore,
} from '../src/external-credential-exchange.js';
import { InMemoryConfigStore, resolveConfigScope } from '../src/store.js';

export const TENANT = 'acme/mail/prod';
export const DEPLOYMENT = 'deploy-123';
export const ISSUER = 'https://cloud.noodleseed.test';
const scope = resolveConfigScope({ org: 'acme', app: 'mail', env: 'prod' });

export function boundArtifact(
  alias: string,
  connectionId: string,
  operation = 'search',
  requiredScopes: readonly string[] = ['gmail.readonly'],
  requiredAudience = 'https://gmail.googleapis.com/',
  presentation: CredentialProfile = { kind: 'bearer' },
  connectionConfigRevision?: string,
): RuntimeArtifact {
  const binding: ArtifactConnectorBinding = {
    profile: 'oauth',
    connection: { id: connectionId, source: { kind: 'externalExchange' } },
  };
  return {
    artifactSchemaVersion: '0.14.0',
    resolution: 'resolved',
    source: { manifestName: 'mail', manifestVersion: '1.0.0', coreVersion: '2' },
    server: { name: 'mail', version: '1.0.0', title: 'Mail' },
    capabilities: { tools: [operation] },
    connectorBindings: { [alias]: binding },
    tools: [
      {
        name: operation,
        description: 'Mail operation.',
        inputSchema: { type: 'object' },
        fulfilment: {
          kind: 'operation',
          args: {},
          operationRef: {
            resolved: true,
            alias,
            connectorId: 'gmail',
            connectorVersion: '1.0.0',
            operation,
            signatureHash: 'sha256v2:test',
            credentialBinding: {
              bindingId: alias,
              connectionId,
              connectionConfigRevision:
                connectionConfigRevision ?? computeConnectionConfigRevision(binding.connection),
              profile: binding.profile,
              presentation,
              requiredScopes,
              requiredAudience,
            },
          },
        },
      },
    ],
  };
}

export function combineArtifacts(...artifacts: readonly RuntimeArtifact[]): RuntimeArtifact {
  const first = artifacts[0];
  if (first === undefined) throw new Error('artifact required');
  const tools = artifacts.flatMap((artifact, artifactIndex) =>
    artifact.tools.map((tool, toolIndex) => ({
      ...tool,
      name: `combined_${artifactIndex}_${toolIndex}_${tool.name}`,
    })),
  );
  return {
    ...first,
    capabilities: { tools: tools.map((tool) => tool.name) },
    connectorBindings: Object.assign(
      {},
      ...artifacts.map((artifact) => artifact.connectorBindings),
    ),
    tools,
  };
}

export function request(artifact: RuntimeArtifact, toolIndex = 0) {
  const fulfilment = artifact.tools[toolIndex]?.fulfilment;
  if (fulfilment?.kind !== 'operation' || !fulfilment.operationRef.resolved) {
    throw new Error('expected operation');
  }
  return {
    connectorId: fulfilment.operationRef.connectorId,
    connectorVersion: fulfilment.operationRef.connectorVersion,
    operation: fulfilment.operationRef.operation,
    ...fulfilment.operationRef.credentialBinding,
    tenantId: TENANT,
    deploymentId: DEPLOYMENT,
  };
}

export function config(
  connectionId: string,
  connectionConfigRevision: string,
  input: Partial<ExternalCredentialProviderConfig> = {},
): ExternalCredentialProviderConfig {
  return {
    tenantId: TENANT,
    deploymentId: DEPLOYMENT,
    connectionId,
    connectionConfigRevision,
    endpoint: 'https://provider.example.test/v1/exchange?private=config',
    allowedOrigin: 'https://provider.example.test',
    assertionAudience: 'urn:provider:mail',
    configRevision: 'provider-config-1',
    ...input,
  };
}

export async function harness(input: {
  readonly artifacts: readonly RuntimeArtifact[];
  readonly configs?: readonly ExternalCredentialProviderConfig[];
  readonly guardedFetch?: typeof fetch;
  readonly now?: () => number;
  readonly dnsLookup?: DnsLookup;
  readonly signer?: SigningKeyProvider;
  readonly subjectPins?: unknown;
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal;
}) {
  const signer = input.signer ?? (await createStaticSigningKeyProvider());
  const artifact = input.artifacts[0];
  if (artifact === undefined) throw new Error('artifact required');
  const providers = new InMemoryExternalCredentialProviderConfigStore(input.configs ?? []);
  const broker = new ManagedConfigBroker([], new InMemoryConfigStore(), scope, {
    artifact,
    externalCredentialExchange: {
      issuer: ISSUER,
      signer,
      tenant: TENANT,
      deployment: DEPLOYMENT,
      providers,
      subjectPins: (Object.hasOwn(input, 'subjectPins')
        ? input.subjectPins
        : new InMemoryExternalCredentialSubjectPinStore()) as ExternalCredentialSubjectPinStore,
      ...(input.guardedFetch === undefined ? {} : { guardedFetch: input.guardedFetch }),
      ...(input.dnsLookup === undefined ? {} : { dnsLookup: input.dnsLookup }),
      ...(input.timeoutSignal === undefined ? {} : { timeoutSignal: input.timeoutSignal }),
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { broker, providers, signer };
}

export function response(
  token: string,
  revision = 'provider-rev-1',
  expiresIn = 120,
  subject = 'opaque-account-subject',
) {
  return Response.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    connection_subject: subject,
    connection_revision: revision,
  });
}
