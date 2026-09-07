import {
  computeSignatureHash,
  type ResolvedOperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { executeTool } from '../src/execute.js';
import { harness, operationRef, SIGNATURE } from './customer-routing-fixtures.js';

describe('customer route fulfilment preflight', () => {
  it('checks every flow route before an earlier static operation can dispatch', async () => {
    const run = harness();
    const sourceRef = operationRef(run.artifact);
    const {
      customerEndpoint: _customerEndpoint,
      customerEndpointDependencies: _customerEndpointDependencies,
      ...staticRef
    } = sourceRef;
    const routedRef: ResolvedOperationRef = {
      ...staticRef,
      operation: 'list_related_records',
      signatureHash: computeSignatureHash('list_related_records', SIGNATURE),
      customerEndpoint: 'missing_api',
      customerEndpointDependencies: ['missing_api'],
    };
    const tool = run.artifact.tools[0];
    if (tool === undefined) throw new Error('expected routed tool');
    const artifact: RuntimeArtifact = {
      ...run.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            kind: 'flow',
            steps: [
              { id: 'static', kind: 'operation', operationRef: staticRef, args: {} },
              { id: 'routed', kind: 'operation', operationRef: routedRef, args: {} },
            ],
            output: {},
          },
        },
      ],
    };

    await expect(executeTool(artifact, 'list_records', {}, run.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'connector_route_unavailable' },
    });
    expect(run.requests).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
  });
});
