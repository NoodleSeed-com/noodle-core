import { describe, expect, it } from 'vitest';
import {
  applicationConnectionReleaseConfig,
  cloudRunRuntimeConfig,
  cloudRunSecretArgs,
  parseCloudRunDescription,
} from '../../../scripts/system-release-runtime-config.mjs';

describe('immutable connection custody release configuration', () => {
  const env = {
    NOODLE_CONNECTION_PROVIDERS_SECRET: 'connection-providers',
    NOODLE_CONNECTION_PROVIDERS_VERSION: '3',
    NOODLE_CONNECTION_CREDENTIAL_EPOCH: 'connection-generation-one',
    NOODLE_OPERATION_EVIDENCE_EPOCH: 'evidence-generation-one',
  };
  it('pins credentials and restore fences and restores the exact prior values', () => {
    const config = applicationConnectionReleaseConfig(env);
    expect(cloudRunRuntimeConfig('service', 'promote', {}, config)).toMatchObject({
      NOODLE_CONNECTION_CREDENTIAL_EPOCH: env.NOODLE_CONNECTION_CREDENTIAL_EPOCH,
      NOODLE_OPERATION_EVIDENCE_EPOCH: env.NOODLE_OPERATION_EVIDENCE_EPOCH,
    });
    expect(cloudRunSecretArgs('service', 'promote', config, {})).toContain(
      'NOODLE_CONNECTION_PROVIDERS=connection-providers:3',
    );
    const previous = {
      connectionProvidersRef: 'old-providers:2',
      connectionCredentialEpoch: 'old-connection-epoch',
      operationEvidenceEpoch: 'old-evidence-epoch',
    };
    expect(cloudRunRuntimeConfig('service', 'rollback', previous, config)).toMatchObject({
      NOODLE_CONNECTION_CREDENTIAL_EPOCH: previous.connectionCredentialEpoch,
      NOODLE_OPERATION_EVIDENCE_EPOCH: previous.operationEvidenceEpoch,
    });
    expect(cloudRunSecretArgs('service', 'rollback', config, previous)).toContain(
      'NOODLE_CONNECTION_PROVIDERS=old-providers:2',
    );
    const removed = cloudRunSecretArgs('service', 'rollback', config, {});
    expect(removed[removed.indexOf('--remove-secrets') + 1]?.split(',')).toContain(
      'NOODLE_CONNECTION_PROVIDERS',
    );
  });
  it('permits a reader-only release before provider consent is configured', () => {
    const config = applicationConnectionReleaseConfig({});
    expect(config.connectionProvidersRef).toBe('');
    expect(config.operationEvidenceEpoch).toBe('operation-evidence-initial-v1');
    expect(cloudRunSecretArgs('service', 'promote', config, {})).toContain(
      'NOODLE_CONNECTION_PROVIDERS',
    );
  });
  it.each([
    { ...env, NOODLE_CONNECTION_PROVIDERS_VERSION: 'latest' },
    { ...env, NOODLE_CONNECTION_PROVIDERS_SECRET: '' },
    { ...env, NOODLE_CONNECTION_CREDENTIAL_EPOCH: 'short' },
    { ...env, NOODLE_OPERATION_EVIDENCE_EPOCH: 'invalid epoch value' },
  ])('rejects partial, unpinned or invalid custody configuration', (input) => {
    expect(() => applicationConnectionReleaseConfig(input)).toThrow();
  });
  it('captures only references and epochs in release evidence', () => {
    const result = parseCloudRunDescription(
      {
        containers: [
          {
            image: `image@sha256:${'a'.repeat(64)}`,
            env: [
              {
                name: 'NOODLE_CONNECTION_PROVIDERS',
                valueFrom: { secretKeyRef: { name: 'connection-providers', key: '3' } },
              },
              {
                name: 'NOODLE_CONNECTION_CREDENTIAL_EPOCH',
                value: env.NOODLE_CONNECTION_CREDENTIAL_EPOCH,
              },
              {
                name: 'NOODLE_OPERATION_EVIDENCE_EPOCH',
                value: env.NOODLE_OPERATION_EVIDENCE_EPOCH,
              },
            ],
          },
        ],
      },
      ['containers'],
    );
    expect(result).toMatchObject({
      connectionProvidersRef: 'connection-providers:3',
      connectionCredentialEpoch: env.NOODLE_CONNECTION_CREDENTIAL_EPOCH,
      operationEvidenceEpoch: env.NOODLE_OPERATION_EVIDENCE_EPOCH,
    });
  });
});
