import { describe, expect, it } from 'vitest';
import {
  deploymentDeleteClientResponseSchema,
  deploymentDeleteResponseSchema,
  deploymentVersionDeleteRequestSchema,
} from '../src/deployment-deletion.js';

const response = {
  ok: true,
  target: { org: 'acme', app: 'hello', env: 'dev' },
  deletedDeploymentIds: ['hello-one', 'hello-two'],
  auditRecorded: true,
};
describe('deployment deletion wire contract', () => {
  it('requires a bounded unique inventory for version deletion', () => {
    expect(
      deploymentVersionDeleteRequestSchema.parse({
        expectedDeploymentIds: ['hello-one', 'hello-two'],
      }),
    ).toEqual({ expectedDeploymentIds: ['hello-one', 'hello-two'] });
    for (const ids of [[], ['hello-one', 'hello-one'], ['../hello']]) {
      expect(
        deploymentVersionDeleteRequestSchema.safeParse({ expectedDeploymentIds: ids }).success,
      ).toBe(false);
    }
    expect(
      deploymentVersionDeleteRequestSchema.safeParse({
        expectedDeploymentIds: ['hello-one'],
        all: true,
      }).success,
    ).toBe(false);
  });
  it('keeps service output strict and client output additive at every layer', () => {
    expect(deploymentDeleteResponseSchema.parse(response)).toEqual(response);
    const extended = { ...response, extra: true, target: { ...response.target, extra: true } };
    expect(deploymentDeleteResponseSchema.safeParse(extended).success).toBe(false);
    expect(deploymentDeleteClientResponseSchema.parse(extended)).toEqual(response);
  });
});
