import type { ArtifactServer, RuntimeArtifact } from '@noodle-borg/compiler';
import type { SecretBinding } from '@noodle-borg/connector-defs';
import { serverAuthVariableBindings } from './managed-config-expressions.js';
import { missingSecretErrors, missingVariableErrors } from './registry-helpers.js';
import type { DeployError } from './registry-types.js';
import { serverAuthSecretBindings } from './server-auth-bindings.js';

const VARIABLE = /\$\{env\.([A-Za-z0-9_]+)\}/g;

function assistantSecretBindings(assistant: ArtifactServer['assistant']): readonly SecretBinding[] {
  return assistant?.model.kind === 'openai-compatible'
    ? [
        {
          connectorId: 'server.assistant',
          connectorVersion: '1',
          secretRef: assistant.model.apiKey,
          authKind: 'static',
        },
      ]
    : [];
}

function assistantVariableBindings(assistant: ArtifactServer['assistant']): readonly string[] {
  if (!assistant) return [];
  if (assistant.model.kind !== 'openai-compatible') return [];
  const names = new Set<string>();
  for (const value of [assistant.model.baseUrl, assistant.model.model]) {
    for (const match of value.matchAll(VARIABLE)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

/** BYO knowledge provider config references (names only) join the missing-config preflight. */
function knowledgeProviderRefs(artifact: RuntimeArtifact): {
  readonly secrets: readonly SecretBinding[];
  readonly variables: readonly string[];
} {
  const secrets: SecretBinding[] = [];
  const variables: string[] = [];
  for (const component of artifact.server.knowledge ?? []) {
    for (const declaration of [component.crawler, component.index]) {
      if (declaration === undefined) continue;
      for (const ref of Object.values(declaration.config)) {
        if (ref.kind === 'secret') {
          secrets.push({
            connectorId: `server.knowledge.${component.name}`,
            connectorVersion: '1',
            secretRef: ref.name,
            authKind: 'static',
          });
        } else {
          variables.push(ref.name);
        }
      }
    }
  }
  return { secrets, variables };
}

export function artifactSecretBindings(artifact: RuntimeArtifact): readonly SecretBinding[] {
  return serverAuthSecretBindings(artifact.server.auth)
    .concat(assistantSecretBindings(artifact.server.assistant))
    .concat(knowledgeProviderRefs(artifact).secrets);
}

export function artifactVariableBindings(artifact: RuntimeArtifact): readonly string[] {
  return [
    ...(artifact.config?.variables ?? []),
    ...serverAuthVariableBindings(artifact.server.auth),
    ...assistantVariableBindings(artifact.server.assistant),
    ...knowledgeProviderRefs(artifact).variables,
  ];
}

export function missingServerConfigErrors(
  artifact: RuntimeArtifact,
  secrets: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, string>>,
): readonly DeployError[] {
  return [
    ...missingSecretErrors(artifactSecretBindings(artifact), secrets),
    ...missingVariableErrors(artifactVariableBindings(artifact), variables),
  ];
}
