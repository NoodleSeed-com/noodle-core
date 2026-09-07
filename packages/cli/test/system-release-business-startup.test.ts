import { describe, expect, it } from 'vitest';
import { businessInformationServiceDeployConfig } from '../../../scripts/system-release-runtime-config.mjs';

const env = {
  PORTAL_SERVICE_ACCOUNT: 'portal-run@example.iam.gserviceaccount.com',
  PUBLIC_BASE_URL: 'https://service.example.com',
  NOODLE_PORTAL_URL: 'https://portal.example.com',
  NOODLE_OAUTH_PORTAL_CLIENT_ID: 'portal-client',
  PORTAL_AUTH_SECRET_SECRET: 'portal-auth',
  PORTAL_AUTH_SECRET_VERSION: '1',
  NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_SECRET: 'source-identity',
  NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_VERSION: '2',
};
describe('preproduction business information service startup', () => {
  it('binds Portal callbacks and persistent source identity before new service startup', () => {
    const result = businessInformationServiceDeployConfig(env, {});
    expect(result.envVars).toContain('NOODLE_PORTAL_URL=https://portal.example.com');
    expect(result.envVars).toContain('NOODLE_OAUTH_PORTAL_CLIENT_ID=portal-client');
    expect(result.secretBindings).toBe('NOODLE_BUSINESS_SOURCE_IDENTITY_KEY=source-identity:2');
    expect(result.removeSecrets).toBe('NOODLE_CONNECTION_PROVIDERS');
  });
  it('pins optional configured providers without exposing their contents', () => {
    const result = businessInformationServiceDeployConfig(
      {
        ...env,
        NOODLE_CONNECTION_PROVIDERS_SECRET: 'providers',
        NOODLE_CONNECTION_PROVIDERS_VERSION: '3',
        NOODLE_CONNECTION_CREDENTIAL_EPOCH: 'credential-epoch-one',
      },
      {},
    );
    expect(result.secretBindings).toContain('NOODLE_CONNECTION_PROVIDERS=providers:3');
    expect(result.removeSecrets).toBe('');
  });
  it.each([
    'NOODLE_PORTAL_URL',
    'NOODLE_OAUTH_PORTAL_CLIENT_ID',
    'NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_VERSION',
  ])('fails before deploy when required configuration is missing: %s', (name) => {
    expect(() => businessInformationServiceDeployConfig({ ...env, [name]: '' }, {})).toThrow();
  });
  it('requires live state and blocks quarantined or stale-epoch preproduction rollout', () => {
    expect(() => businessInformationServiceDeployConfig(env)).toThrow(/live service/i);
    expect(() =>
      businessInformationServiceDeployConfig(env, { recoveryMode: 'quarantined' }),
    ).toThrow(/quarantined/i);
    expect(() =>
      businessInformationServiceDeployConfig(env, {
        recoveryMode: 'reopened',
        operationEvidenceEpoch: 'newer-recovery-epoch-0002',
      }),
    ).toThrow(/recovery epochs/i);
  });
});
