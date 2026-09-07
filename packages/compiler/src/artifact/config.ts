import type { ExprNode } from '../manifest/expression.js';
import type { Manifest } from '../manifest/schema.js';
import type {
  ArtifactConnectorBinding,
  ArtifactFulfilment,
  ArtifactPrompt,
  ArtifactResource,
  ArtifactTool,
} from './types.js';

export function artifactConfig(
  manifest: Manifest,
  tools: readonly ArtifactTool[],
  resources: readonly ArtifactResource[],
  prompts: readonly ArtifactPrompt[],
  connectorBindings: Readonly<Record<string, ArtifactConnectorBinding>>,
  ambientFulfilment?: ArtifactFulfilment,
): { readonly variables?: readonly string[] } | undefined {
  const variables = new Set<string>();
  collectVariablesFromManagedOrigins(manifest, variables);
  for (const tool of tools) collectVariablesFromFulfilment(tool.fulfilment, variables);
  for (const resource of resources) collectVariablesFromFulfilment(resource.fulfilment, variables);
  for (const prompt of prompts) collectVariablesFromFulfilment(prompt.fulfilment, variables);
  if (ambientFulfilment !== undefined) collectVariablesFromFulfilment(ambientFulfilment, variables);
  for (const binding of Object.values(connectorBindings))
    collectVariablesFromConnectionSource(binding.connection.source, variables);
  return variables.size > 0 ? { variables: [...variables].sort() } : undefined;
}
function collectVariablesFromManagedOrigins(manifest: Manifest, out: Set<string>): void {
  const assistant = manifest.server.assistant;
  const values = [
    ...(assistant?.allowedOrigins ?? []),
    ...(assistant?.surfaces?.flatMap((surface) => surface.origins) ?? []),
    ...(manifest.handoff?.allowedDomains ?? []),
  ];
  for (const value of values) {
    const match = /^\$\{env\.([A-Za-z0-9_]+)\}$/.exec(value);
    if (match?.[1] !== undefined) out.add(match[1]);
  }
}
function collectVariablesFromConnectionSource(
  source: ArtifactConnectorBinding['connection']['source'],
  out: Set<string>,
): void {
  const values =
    source.kind === 'clientCredentials'
      ? [source.tokenUrl, source.clientId]
      : source.kind === 'googleWorkloadIdentity'
        ? [
            source.provider,
            ...(source.access.kind === 'serviceAccountImpersonation'
              ? [source.access.serviceAccount]
              : []),
          ]
        : [];
  for (const value of values) {
    for (const match of value.matchAll(/\$\{env\.([A-Za-z0-9_]+)\}/g)) {
      if (match[1] !== undefined) out.add(match[1]);
    }
  }
}
function collectVariablesFromFulfilment(fulfilment: ArtifactFulfilment, out: Set<string>): void {
  if (fulfilment.kind === 'operation') {
    collectVariablesFromExprMap(fulfilment.args, out);
    return;
  }
  for (const step of fulfilment.steps) {
    if (step.kind === 'operation') collectVariablesFromExprMap(step.args, out);
    else if (step.kind === 'map') collectVariablesFromExprMap(step.value, out);
  }
  collectVariablesFromExprMap(fulfilment.output, out);
}
function collectVariablesFromExprMap(
  map: Readonly<Record<string, ExprNode>>,
  out: Set<string>,
): void {
  for (const node of Object.values(map)) collectVariablesFromExpr(node, out);
}
function collectVariablesFromExpr(node: ExprNode, out: Set<string>): void {
  if (node.kind === 'path') {
    const first = node.segments[0];
    if (node.root === 'env' && first?.kind === 'prop') out.add(first.name);
  } else if (node.kind === 'template') {
    for (const part of node.parts) {
      if (part.kind !== 'text') collectVariablesFromExpr(part, out);
    }
  } else if (node.kind === 'array') {
    for (const item of node.items) collectVariablesFromExpr(item, out);
  } else if (node.kind === 'object') {
    for (const entry of node.entries) collectVariablesFromExpr(entry.value, out);
  } else if (node.kind === 'coalesce') {
    collectVariablesFromExpr(node.left, out);
    collectVariablesFromExpr(node.right, out);
  } else if (node.kind === 'function') {
    for (const arg of node.args) collectVariablesFromExpr(arg, out);
  }
}
