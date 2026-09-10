import {
  projectManagedCollectionControls,
  RECORD_OPERATION_SIGNATURES,
} from '@noodle-borg/compiler';
import { collectionToPublicWire } from '../routes/business-information-wire.js';
import type { SolutionDefinitionSnapshot } from './contracts.js';
import { managedSolutionBlueprint } from './managed-solution-blueprints.js';

/** System-owned manifest data for an explicitly curated solution, admitted by the ordinary compiler. */
export function managedSolutionManifest(
  definition: SolutionDefinitionSnapshot,
): Record<string, unknown> {
  const ref = definition.reference;
  const blueprint =
    ref.kind === 'managed' ? managedSolutionBlueprint(ref.definitionId, ref.release) : undefined;
  if (blueprint === undefined)
    throw new Error('Managed solution executable is unavailable for this release');
  const collection = definition.collections.find((entry) => entry.key === blueprint.collection);
  if (collection === undefined)
    throw new Error('Managed solution executable collection is missing');
  const recordInput = collectionToPublicWire(collection).recordSchema;
  const inputSchema =
    'followUpContact' in blueprint
      ? {
          ...recordInput,
          required: [
            ...(Array.isArray(recordInput.required) ? recordInput.required : []),
            'contact_email',
          ],
        }
      : recordInput;
  return {
    manifestVersion: '2',
    server: {
      name: ref.kind === 'managed' ? ref.definitionId : 'solution',
      version: `${ref.kind === 'managed' ? ref.release : 1}.0.0`,
      title: definition.title,
      interactions: { confirmationFallback: 'host' },
      instructions: `${definition.description} Request submission creates a record for staff review. Never claim that an external booking, payment, refund, order or reservation was completed.`,
      variables: definition.variables?.map(({ schemaDigest: _, ...declaration }) => declaration),
      collections: definition.collections.map((entry) => ({
        name: entry.key,
        title: entry.title,
        description: entry.description,
        schemaVersion: entry.schemaVersion,
        recordSchema: entry.recordSchema,
        ...projectManagedCollectionControls(entry),
        summaryFields: entry.summaryFields,
      })),
      assistant: {
        model: { kind: 'noodle-managed' },
        allowedOrigins: ['${env.WEBSITE_ORIGIN}'],
        surfaces: [
          {
            mode: 'public',
            origins: ['${env.WEBSITE_ORIGIN}'],
            capabilities: [{ kind: 'tool', name: blueprint.tool }],
          },
        ],
      },
    },
    connectors: { records: { id: 'noodle_records', version: '1.0.0' } },
    tools: [
      {
        name: blueprint.tool,
        title: blueprint.title,
        description: blueprint.description,
        inputSchema,
        outputSchema: RECORD_OPERATION_SIGNATURES.submit_record?.output,
        annotations: {
          confirm: true,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        fulfilment: {
          steps: [
            {
              id: 'submit',
              use: 'records.submit_record',
              args: { collection: collection.key, payload: '${input}' },
            },
          ],
          output: {
            ok: '${steps.submit.ok}',
            recordId: '${steps.submit.recordId}',
            revision: '${steps.submit.revision}',
          },
        },
      },
    ],
  };
}
