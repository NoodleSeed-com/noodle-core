import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { InMemoryConfigStore, resolveConfigScope } from '../src/store.js';
import {
  boundArtifact,
  DEPLOYMENT,
  request,
  TENANT,
} from './external-credential-exchange.fixtures.js';

const result = {
  access_token: 'private-access',
  token_type: 'Bearer' as const,
  expires_in: 300,
  connection_subject: 'subject-1',
  connection_revision: 'generation-1',
};
describe('portable account broker authority', () => {
  it('rechecks local authority on every call and denies undeclared or cross-deployment requests first', async () => {
    const artifact = boundArtifact('records', 'account');
    const getCredential = vi.fn(async () => result);
    const broker = new ManagedConfigBroker(
      [],
      new InMemoryConfigStore(),
      resolveConfigScope({ org: 'acme', app: 'mail', env: 'prod' }),
      {
        artifact,
        externalCredentialExchange: {
          tenant: TENANT,
          deployment: DEPLOYMENT,
          localProvider: { getCredential },
        },
      },
    );
    const call = request(artifact);
    expect(await broker.getCredential(call)).toEqual({ token: result.access_token });
    expect(await broker.getCredential(call)).toEqual({ token: result.access_token });
    expect(getCredential).toHaveBeenCalledTimes(2);
    await expect(broker.getCredential({ ...call, deploymentId: 'other' })).rejects.toThrow();
    await expect(broker.getCredential({ ...call, operation: 'undeclared' })).rejects.toThrow();
    expect(getCredential).toHaveBeenCalledTimes(2);
    getCredential.mockRejectedValueOnce(new Error('private provider failure'));
    await expect(broker.getCredential(call)).rejects.toThrow('credential_exchange_failed');
    expect(getCredential).toHaveBeenCalledTimes(3);
  });
});
