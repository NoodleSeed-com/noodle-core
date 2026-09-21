import {
  type ArtifactFulfilment,
  isNativeRecordsOperation,
  type OperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';

/**
 * Runtime twin of the compiler's messaging requirement check (ADR 0240). A binding selects a subset
 * of the authored surface, so the projected artifact is re-checked with the compiler's own
 * native-records predicate: pure reads and knowledge pass as before; a `collect` opener passes with
 * its confirmed native-record action selected beside it; everything else names, as a channel error
 * code, the requirement the messaging profile lacks.
 */
export function messagingProjectionIneligibility(artifact: RuntimeArtifact): string | undefined {
  const interactions = artifact.toolInteractions ?? {};
  const present = new Set(artifact.tools.map((tool) => tool.name));
  const actions = new Set(
    Object.entries(interactions)
      .filter(([opener]) => present.has(opener))
      .map(([, interaction]) => interaction.action),
  );
  for (const tool of artifact.tools) {
    const interaction = interactions[tool.name];
    if (interaction !== undefined && !present.has(interaction.action))
      return 'channel_dependency_missing';
    const operations = operationRefs(tool.fulfilment);
    if (actions.has(tool.name)) {
      const [operation] = operations;
      if (operations.length !== 1 || operation === undefined) return 'messaging_action_unsupported';
      if (!isNativeRecordsOperation(operation, undefined)) return 'external_lookup_not_enabled';
      continue;
    }
    if (
      tool.annotations?.readOnlyHint !== true ||
      (tool._meta?.ui !== undefined && interaction === undefined)
    )
      return 'messaging_action_unsupported';
    // No separately budgeted connector-backed inference yet: external lookups need their own slice.
    if (operations.length > 0) return 'external_lookup_not_enabled';
  }
  const ambient = artifact.server.context?.ambient;
  if (ambient !== undefined && operationRefs(ambient.fulfilment).length > 0)
    return 'external_lookup_not_enabled';
  return undefined;
}

function operationRefs(fulfilment: ArtifactFulfilment): readonly OperationRef[] {
  return fulfilment.kind === 'operation'
    ? [fulfilment.operationRef]
    : fulfilment.steps.flatMap((step) => (step.kind === 'operation' ? [step.operationRef] : []));
}
