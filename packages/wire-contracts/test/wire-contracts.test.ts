import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_KNOWLEDGE_COMPONENTS } from '@noodle-borg/knowledge/limits';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_MODES,
  AlertRuleResponseSchema,
  AlertRulesListResponseSchema,
  AppResponseSchema,
  AppsListResponseSchema,
  accessModeSchema,
  accessUpdateClientResponseSchema,
  accessUpdateRequestSchema,
  accessUpdateResponseSchema,
  assetPreflightRequestSchema,
  assetPreflightResponseSchema,
  assistantInteractionRequestSchema,
  assistantModelContextUpdateSchema,
  assistantSessionResponseSchema,
  assistantTurnRequestSchema,
  assistantWireEventSchema,
  BillingAccountClientResponseSchema,
  BillingAccountResponseSchema,
  BillingAccountsListClientResponseSchema,
  BillingAccountsListResponseSchema,
  BillingEnforcementActivationPreviewClientResponseSchema,
  BillingEnforcementActivationPreviewResponseSchema,
  BillingMeterReadinessClientResponseSchema,
  BillingMeterReadinessResponseSchema,
  BillingStripeCheckoutClientResponseSchema,
  BillingStripeCheckoutResponseSchema,
  BillingStripePortalClientResponseSchema,
  BillingStripePortalResponseSchema,
  configValueSetRequestSchema,
  configValueSetResponseSchema,
  configValuesListResponseSchema,
  DeploymentPackageResponseShapeSchema,
  DeploymentResponseSchema,
  deployErrorResponseSchema,
  deploymentOwnerSubjectSchema,
  deployPreflightRequestSchema,
  deployPreflightResponseSchema,
  deployRequestSchema,
  deploySuccessResponseSchema,
  EffectiveConfigResponseSchema,
  EnvResponseSchema,
  EnvsListResponseSchema,
  FEEDBACK_ERROR_CODES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  FEEDBACK_SEVERITIES,
  FEEDBACK_SEVERITY_DEFAULT,
  FEEDBACK_TITLE_MAX,
  FEEDBACK_TITLE_MIN,
  FEEDBACK_TYPE_DEFAULT,
  FEEDBACK_TYPES,
  FeedbackErrorResponseSchema,
  FeedbackSubmissionSchema,
  formatWireError,
  GithubConnectionResponseSchema,
  GithubInstallUrlResponseSchema,
  GithubRunsListResponseSchema,
  knowledgePreflightRequestSchema,
  knowledgePreflightResponseSchema,
  knowledgeStatusResponseSchema,
  LegacyBillingMigrationClientPreviewResponseSchema,
  LegacyBillingMigrationPreviewResponseSchema,
  OrgBillingClientResponseSchema,
  OrgBillingResponseSchema,
  PlatformAccountResetExecuteRequestSchema,
  PlatformAccountResetResultClientResponseSchema,
  PlatformAccountResetResultResponseSchema,
  PlatformAccountResetTargetSetSchema,
  PlatformAuthOperatorClientResponseSchema,
  PlatformAuthOperatorResponseSchema,
  PlatformAuthPreviewRequestSchema,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '..', '..', '..', 'contract', 'v1');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(contractDir, name), 'utf8'));

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object fixture');
  }
  return value as Record<string, unknown>;
}

function mutableRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('expected an array fixture');
  return value.map(mutableRecord);
}

describe('deployRequestSchema org membership sources (ADR 0183)', () => {
  const base = { manifest: '{}', accessMode: 'org-members' } as const;

  it('accepts exactly the canonical membership sources', () => {
    for (const sources of [['explicit'], ['domain'], ['explicit', 'domain']]) {
      expect(
        deployRequestSchema.safeParse({ ...base, orgMembershipSources: sources }).success,
      ).toBe(true);
    }
  });

  it('rejects a source this contract does not define', () => {
    const parsed = deployRequestSchema.safeParse({ ...base, orgMembershipSources: ['group'] });
    expect(parsed.success).toBe(false);
  });

  // An empty list would deploy an endpoint nobody can call, so it is a wire error, not a deny-all posture.
  it('rejects an empty membership source list', () => {
    expect(deployRequestSchema.safeParse({ ...base, orgMembershipSources: [] }).success).toBe(
      false,
    );
  });

  it('stays optional so an ordinary deploy is unchanged', () => {
    expect(deployRequestSchema.safeParse(base).success).toBe(true);
  });
});

describe('deploy-lane golden fixtures parse against the wire schemas (ADR 0150)', () => {
  const cases = [
    ['deploy-request.json', deployRequestSchema],
    ['deploy-request.json', deployPreflightRequestSchema],
    ['deploy-response.json', deploySuccessResponseSchema],
    ['deploy-error-response.json', deployErrorResponseSchema],
    ['deploy-preflight-response.json', deployPreflightResponseSchema],
    ['asset-preflight-request.json', assetPreflightRequestSchema],
    ['asset-preflight-response.json', assetPreflightResponseSchema],
    ['config-value-set-request.json', configValueSetRequestSchema],
    ['config-value-set-response.json', configValueSetResponseSchema],
    ['config-values-list-response.json', configValuesListResponseSchema],
    ['assistant-session-response.json', assistantSessionResponseSchema],
    ['assistant-interaction-request.json', assistantInteractionRequestSchema],
    ['assistant-turn-request.json', assistantTurnRequestSchema],
  ] as const;

  it.each(cases)('%s', (name, schema) => {
    const parsed = schema.safeParse(fixture(name));
    if (!parsed.success) throw new Error(formatWireError(parsed.error));
    expect(parsed.success).toBe(true);
  });
});

describe('strict service-output golden contracts (ADR 0128)', () => {
  const cases = [
    ['apps-list-response.json', AppsListResponseSchema],
    ['app-response.json', AppResponseSchema],
    ['envs-list-response.json', EnvsListResponseSchema],
    ['env-response.json', EnvResponseSchema],
    ['deployment-response.json', DeploymentResponseSchema],
    ['deployment-package-response.json', DeploymentPackageResponseShapeSchema],
    ['github-connection-response.json', GithubConnectionResponseSchema],
    ['github-runs-response.json', GithubRunsListResponseSchema],
    ['github-install-url-response.json', GithubInstallUrlResponseSchema],
    ['alert-rule-response.json', AlertRuleResponseSchema],
    ['alert-rules-list-response.json', AlertRulesListResponseSchema],
  ] as const;

  it.each(cases)('%s', (name, schema) => {
    expect(schema.safeParse(fixture(name)).success).toBe(true);
  });

  it.each([
    ['apps-list-response.json', ['data', 'apps', 0, 'latest', 'ownerSubject']],
    ['app-response.json', ['data', 'latest', 'ownerSubject']],
    ['envs-list-response.json', ['data', 'envs', 0, 'latest', 'ownerSubject']],
    ['env-response.json', ['data', 'latest', 'ownerSubject']],
    ['deployment-response.json', ['data', 'ownerSubject']],
  ] as const)('%s preserves the exact deployment owner', (name, path) => {
    let value = fixture(name);
    for (const segment of path) value = (value as Record<PropertyKey, unknown>)[segment];
    expect(value).toBe('oauth-owner-123');
  });

  it('keeps a pre-owner deployment inspection body compatible', () => {
    const response = mutableRecord(structuredClone(fixture('deployment-response.json')));
    const data = mutableRecord(response.data);
    delete data.ownerSubject;
    expect(DeploymentResponseSchema.parse(response).data.ownerSubject).toBeUndefined();
  });

  it('rejects an undeclared service response field while clients remain type-only consumers', () => {
    const response = fixture('apps-list-response.json') as Record<string, unknown>;
    expect(AppsListResponseSchema.safeParse({ ...response, undeclared: true }).success).toBe(false);
  });

  it('keeps effective managed configuration output strict and value-safe by kind', () => {
    const response = {
      kind: 'secret',
      environment: { id: 'env_1', name: 'prod', isProduction: true },
      capabilities: { canManage: true, canReveal: false },
      entries: [
        {
          name: 'API_KEY',
          source: {
            kind: 'environment',
            organizationId: 'org_1',
            appId: 'app_1',
            environmentId: 'env_1',
            environmentName: 'prod',
            isProduction: true,
          },
        },
      ],
    };
    expect(EffectiveConfigResponseSchema.safeParse(response).success).toBe(true);
    expect(
      EffectiveConfigResponseSchema.safeParse({ ...response, secretValue: 'must-not-pass' })
        .success,
    ).toBe(false);
  });
});

describe('billing read contracts', () => {
  const cases = [
    [
      'billing-account-response.json',
      BillingAccountResponseSchema,
      BillingAccountClientResponseSchema,
    ],
    [
      'billing-accounts-list-response.json',
      BillingAccountsListResponseSchema,
      BillingAccountsListClientResponseSchema,
    ],
    ['org-billing-response.json', OrgBillingResponseSchema, OrgBillingClientResponseSchema],
  ] as const;

  it.each(cases)('%s remains a strict server contract', (name, strictSchema) => {
    const response = fixture(name) as Record<string, unknown>;
    expect(strictSchema.safeParse(response).success).toBe(true);
    expect(strictSchema.safeParse({ ...response, futureEnvelope: true }).success).toBe(false);
  });

  it.each(
    cases,
  )('%s tolerates additive client fields at every object layer', (name, _, clientSchema) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    const data = mutableRecord(response.data);
    response.futureEnvelope = true;
    data.futureData = true;
    if ('account' in data) {
      const account = mutableRecord(data.account);
      account.futureAccount = true;
      mutableRecord(account.enforcement).futureNested = true;
    } else if ('accounts' in data) {
      const account = mutableRecords(data.accounts)[0] as Record<string, unknown>;
      account.futureAccount = true;
      mutableRecord(account.plan).futureNested = true;
    } else {
      mutableRecord(data.plan).futureNested = true;
      mutableRecord(data.productionApps).futureProduction = true;
    }
    expect(clientSchema.safeParse(response).success).toBe(true);
  });

  it.each(
    cases,
  )('%s client schema still rejects missing required fields', (name, _, clientSchema) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    delete response.data;
    expect(clientSchema.safeParse(response).success).toBe(false);
  });
});

describe('billing operation contracts', () => {
  const responseCases = [
    [
      'billing-checkout-response.json',
      BillingStripeCheckoutResponseSchema,
      BillingStripeCheckoutClientResponseSchema,
    ],
    [
      'billing-portal-response.json',
      BillingStripePortalResponseSchema,
      BillingStripePortalClientResponseSchema,
    ],
  ] as const;

  it.each(
    responseCases,
  )('%s is strict for servers and additive for clients', (name, strict, client) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    const data = mutableRecord(response.data);
    expect(strict.safeParse(response).success).toBe(true);
    response.futureEnvelope = true;
    data.futureData = true;
    expect(strict.safeParse(response).success).toBe(false);
    expect(client.safeParse(response).success).toBe(true);
    delete data.url;
    expect(client.safeParse(response).success).toBe(false);
  });
});

describe('hosted billing operation response contracts', () => {
  const responseCases = [
    [
      'billing-metering-readiness-response.json',
      BillingMeterReadinessResponseSchema,
      BillingMeterReadinessClientResponseSchema,
      (response: Record<string, unknown>) => {
        const data = mutableRecord(response.data);
        mutableRecord(data.metering).futureNested = true;
        (mutableRecords(data.checks)[0] as Record<string, unknown>).futureCheck = true;
      },
      (response: Record<string, unknown>) => delete mutableRecord(response.data).checkedAt,
    ],
    [
      'billing-enforcement-activation-preview-response.json',
      BillingEnforcementActivationPreviewResponseSchema,
      BillingEnforcementActivationPreviewClientResponseSchema,
      (response: Record<string, unknown>) => {
        mutableRecord(mutableRecord(response.data).effects).futureEffect = true;
      },
      (response: Record<string, unknown>) => delete mutableRecord(response.data).previewChecksum,
    ],
    [
      'billing-migration-preview-response.json',
      LegacyBillingMigrationPreviewResponseSchema,
      LegacyBillingMigrationClientPreviewResponseSchema,
      (response: Record<string, unknown>) => {
        const data = mutableRecord(response.data);
        (mutableRecords(data.organizations)[0] as Record<string, unknown>).futureOrganization =
          true;
        const fundingSet = mutableRecords(data.fundingSets)[0] as Record<string, unknown>;
        mutableRecord(fundingSet.destination).futureDestination = true;
      },
      (response: Record<string, unknown>) => delete mutableRecord(response.data).previewChecksum,
    ],
  ] as const;

  it.each(
    responseCases,
  )('%s is strict for servers and additive at envelope, data, and nested client layers', (name, strict, client, addNested) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    const data = mutableRecord(response.data);
    expect(strict.safeParse(response).success).toBe(true);
    response.futureEnvelope = true;
    data.futureData = true;
    addNested(response);
    expect(strict.safeParse(response).success).toBe(false);
    expect(client.safeParse(response).success).toBe(true);
  });

  it.each(
    responseCases,
  )('%s rejects a missing required client field', (name, _, client, _addNested, remove) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    remove(response);
    expect(client.safeParse(response).success).toBe(false);
  });
});

describe('platform account-reset contracts', () => {
  it('keeps target and mutation evidence strict', () => {
    const targets = {
      schemaVersion: 1,
      principalIds: ['legacy-google-1', 'legacy-google-2', 'legacy-google-3'],
    };
    expect(PlatformAccountResetTargetSetSchema.safeParse(targets).success).toBe(true);
    expect(
      PlatformAccountResetTargetSetSchema.safeParse({ ...targets, future: true }).success,
    ).toBe(false);
    const execute = {
      schemaVersion: 1,
      action: 'quarantine',
      operationId: 'reset-operation-1',
      expectedGeneration: 4,
      releaseSha: 'a'.repeat(40),
      previewChecksum: 'b'.repeat(64),
      idempotencyKey: 'quarantine-reset-1',
      reason: 'customer-approved account reset',
      confirmed: true,
    };
    expect(PlatformAccountResetExecuteRequestSchema.safeParse(execute).success).toBe(true);
    expect(
      PlatformAccountResetExecuteRequestSchema.safeParse({ ...execute, future: true }).success,
    ).toBe(false);
  });

  it('keeps the server response strict while the client response is deeply additive', () => {
    const response = mutableRecord(
      structuredClone(fixture('platform-account-reset-response.json')),
    );
    const data = mutableRecord(response.data);
    expect(PlatformAccountResetResultResponseSchema.safeParse(response).success).toBe(true);
    response.futureEnvelope = true;
    data.futureData = true;
    mutableRecord(data.counts).futureCount = 1;
    (mutableRecords(data.blockers)[0] as Record<string, unknown>).futureBlocker = true;
    expect(PlatformAccountResetResultResponseSchema.safeParse(response).success).toBe(false);
    expect(PlatformAccountResetResultClientResponseSchema.safeParse(response).success).toBe(true);
    delete data.operationId;
    expect(PlatformAccountResetResultClientResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('platform authentication contracts', () => {
  it('keeps operator requests and evidence strict', () => {
    const request = { schemaVersion: 1, operation: 'reconcile', batchSize: 25 };
    expect(PlatformAuthPreviewRequestSchema.safeParse(request).success).toBe(true);
    expect(PlatformAuthPreviewRequestSchema.safeParse({ ...request, future: true }).success).toBe(
      false,
    );
  });

  it('keeps server output strict while client readers tolerate nested additions', () => {
    const response = mutableRecord(structuredClone(fixture('platform-auth-status-response.json')));
    const data = mutableRecord(response.data);
    expect(PlatformAuthOperatorResponseSchema.safeParse(response).success).toBe(true);
    response.futureEnvelope = true;
    data.futureData = true;
    mutableRecord(data.rollout).futureRollout = true;
    mutableRecord(mutableRecord(data.synchronization).outbox).futureOutbox = true;
    expect(PlatformAuthOperatorResponseSchema.safeParse(response).success).toBe(false);
    expect(PlatformAuthOperatorClientResponseSchema.safeParse(response).success).toBe(true);
    delete data.releaseSha;
    expect(PlatformAuthOperatorClientResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('deployRequestSchema', () => {
  const valid = fixture('deploy-request.json') as Record<string, unknown>;

  it('requires a non-empty manifest string', () => {
    expect(deployRequestSchema.safeParse({ ...valid, manifest: undefined }).success).toBe(false);
    expect(deployRequestSchema.safeParse({ ...valid, manifest: '' }).success).toBe(false);
    expect(deployRequestSchema.safeParse({ ...valid, manifest: 42 }).success).toBe(false);
  });

  it('accepts the minimal body (manifest only; accessMode/serverVersion are server-defaulted)', () => {
    expect(deployRequestSchema.parse({ manifest: '{}x' })).toEqual({ manifest: '{}x' });
  });

  it.each([
    { accessMode: 'owner-only', label: 'explicit owner-only' },
    { accessMode: undefined, label: 'defaulted owner-only' },
  ])('accepts and preserves an exact owner subject with $label access', ({ accessMode }) => {
    const request = {
      manifest: '{...}',
      ...(accessMode === undefined ? {} : { accessMode }),
      ownerSubject: 'oauth-owner-123',
      serverVersion: '1',
    };

    expect(deployRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ['', 'empty'],
    ['x'.repeat(513), '513 characters'],
    [' oauth-owner-123', 'leading whitespace'],
    ['oauth-owner-123 ', 'trailing whitespace'],
    ['oauth\u0000owner', 'C0 NUL'],
    ['oauth\u001fowner', 'C0 unit separator'],
    ['oauth\u007fowner', 'DEL'],
  ])('rejects an owner subject containing %s (%s)', (ownerSubject) => {
    expect(
      deployRequestSchema.safeParse({ manifest: '{...}', accessMode: 'owner-only', ownerSubject })
        .success,
    ).toBe(false);
  });

  it('rejects an owner subject when the effective access mode is not owner-only', () => {
    expect(
      deployRequestSchema.safeParse({
        manifest: '{...}',
        accessMode: 'public',
        ownerSubject: 'oauth-owner-123',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown access mode', () => {
    expect(deployRequestSchema.safeParse({ ...valid, accessMode: 'caller-key' }).success).toBe(
      false,
    );
  });

  it('accepts and preserves exactly the canonical deployment sources', () => {
    for (const deploymentSource of ['console-example', 'cli', 'github', 'api']) {
      const parsed = deployRequestSchema.safeParse({ manifest: '{}x', deploymentSource });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.deploymentSource).toBe(deploymentSource);
    }
    expect(
      deployRequestSchema.safeParse({ manifest: '{}x', deploymentSource: 'browser' }).success,
    ).toBe(false);
  });

  it('rejects malformed hosted assets with a dotted path', () => {
    const parsed = deployRequestSchema.safeParse({
      ...valid,
      hostedAssets: [{ logicalId: 'x' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(formatWireError(parsed.error)).toContain('hostedAssets.0.');
  });
});

describe('deployPreflightResponseSchema', () => {
  const valid = fixture('deploy-preflight-response.json') as Record<string, unknown>;

  it('reports target creation and every missing config name without accepting values', () => {
    const parsed = deployPreflightResponseSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.target).toMatchObject({
      appState: 'will-create',
      environmentState: 'will-create',
    });
    expect(parsed.data.config).toEqual({
      ready: false,
      missingSecrets: ['ASSISTANT_MODEL_API_KEY'],
      missingVariables: ['ASSISTANT_MODEL', 'ASSISTANT_MODEL_BASE_URL'],
    });
    expect(JSON.stringify(parsed.data)).not.toContain('secret-value');
    expect(parsed.data.ownerSubject).toBe('oauth-owner-123');
  });

  it('keeps the pre-owner response body compatible', () => {
    const { ownerSubject: _ownerSubject, ...olderBody } = valid;
    const parsed = deployPreflightResponseSchema.parse(olderBody);
    expect(parsed.ownerSubject).toBeUndefined();
  });

  it('rejects accidental config values on the readiness surface', () => {
    const config = valid.config as Record<string, unknown>;
    expect(
      deployPreflightResponseSchema.safeParse({
        ...valid,
        config: { ...config, values: { ASSISTANT_MODEL_API_KEY: 'secret-value' } },
      }).success,
    ).toBe(true);
    const parsed = deployPreflightResponseSchema.parse({
      ...valid,
      config: { ...config, values: { ASSISTANT_MODEL_API_KEY: 'secret-value' } },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret-value');
  });
});

describe('assistant confirmation presentation', () => {
  it('accepts additive business-readable metadata without changing arguments', () => {
    expect(
      assistantWireEventSchema.safeParse({
        event: 'tool_proposed',
        data: {
          id: 'confirmation_1',
          tool: 'complete_task',
          title: 'Complete task',
          description: 'Marks this task complete.',
          arguments: { taskId: 'task_123' },
          reviewSchema: {
            type: 'object',
            properties: { taskId: { type: 'string', title: 'Task' } },
          },
          requiresConfirmation: true,
        },
      }).success,
    ).toBe(true);
  });
});

describe('accessModeSchema', () => {
  it('accepts exactly the canonical six modes', () => {
    expect(ACCESS_MODES).toHaveLength(6);
    for (const mode of ACCESS_MODES) {
      expect(accessModeSchema.safeParse(mode).success).toBe(true);
    }
    expect(accessModeSchema.safeParse('caller-key').success).toBe(false);
  });
});

describe('FeedbackSubmissionSchema', () => {
  it('owns feedback length minima and enum defaults as exported contract constants', () => {
    const minimum = FeedbackSubmissionSchema.parse({ message: 'x' });
    expect(minimum).toMatchObject({
      type: FEEDBACK_TYPE_DEFAULT,
      severity: FEEDBACK_SEVERITY_DEFAULT,
    });
    expect(
      FeedbackSubmissionSchema.safeParse({ message: 'x'.repeat(FEEDBACK_MESSAGE_MAX) }).success,
    ).toBe(true);
    expect(
      FeedbackSubmissionSchema.safeParse({ message: 'x'.repeat(FEEDBACK_MESSAGE_MAX + 1) }).success,
    ).toBe(false);
    expect(
      FeedbackSubmissionSchema.safeParse({ message: 'x'.repeat(FEEDBACK_MESSAGE_MIN - 1) }).success,
    ).toBe(false);
    expect(
      FeedbackSubmissionSchema.safeParse({ message: 'x', title: 'x'.repeat(FEEDBACK_TITLE_MAX) })
        .success,
    ).toBe(true);
    expect(
      FeedbackSubmissionSchema.safeParse({
        message: 'x',
        title: 'x'.repeat(FEEDBACK_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      FeedbackSubmissionSchema.safeParse({
        message: 'x',
        title: 'x'.repeat(FEEDBACK_TITLE_MIN - 1),
      }).success,
    ).toBe(false);
    for (const type of FEEDBACK_TYPES)
      expect(FeedbackSubmissionSchema.safeParse({ message: 'x', type }).success).toBe(true);
    for (const severity of FEEDBACK_SEVERITIES)
      expect(FeedbackSubmissionSchema.safeParse({ message: 'x', severity }).success).toBe(true);
  });

  it('accepts bounded coding-agent provenance and rejects malformed values', () => {
    expect(
      FeedbackSubmissionSchema.parse({
        message: 'x',
        codingAgent: { name: 'codex', model: 'gpt-5.6-sol' },
      }),
    ).toMatchObject({
      codingAgent: { name: 'codex', model: 'gpt-5.6-sol' },
    });
    expect(
      FeedbackSubmissionSchema.safeParse({
        message: 'x',
        codingAgent: { name: 'codex' },
      }).success,
    ).toBe(true);
    for (const codingAgent of [
      { name: '' },
      { name: 'codex\ninjected' },
      { name: 'codex\n' },
      { name: '\ncodex' },
      { name: 'x'.repeat(65) },
      { name: 'codex', model: '' },
      { name: 'codex', model: 'model\ninjected' },
      { name: 'codex', model: 'model\n' },
      { name: 'codex', model: 'x'.repeat(65) },
      { name: 'codex', extra: 'untrusted' },
    ]) {
      expect(FeedbackSubmissionSchema.safeParse({ message: 'x', codingAgent }).success).toBe(false);
    }
  });

  it('validates every stable feedback service failure code and rejects malformed errors', () => {
    expect(FEEDBACK_ERROR_CODES).toEqual([
      'invalid_feedback',
      'feedback_rate_limited',
      'feedback_unavailable',
      'feedback_recording_failed',
    ]);
    for (const code of FEEDBACK_ERROR_CODES) {
      expect(FeedbackErrorResponseSchema.safeParse({ error: 'safe message', code }).success).toBe(
        true,
      );
    }
    expect(
      FeedbackErrorResponseSchema.safeParse({ error: 'safe message', code: 'service_error' })
        .success,
    ).toBe(false);
    expect(
      FeedbackErrorResponseSchema.safeParse({
        error: 'safe message',
        code: 'invalid_feedback',
        token: 'must-not-pass',
      }).success,
    ).toBe(false);
  });
});

describe('response schemas strip unknown keys instead of failing (additive tolerance)', () => {
  it('deploy success response tolerates a future extra field', () => {
    const body = { ...(fixture('deploy-response.json') as Record<string, unknown>), extra: 1 };
    const parsed = deploySuccessResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('extra' in parsed.data).toBe(false);
  });

  it('preserves the exact deployment owner while accepting the pre-owner response body', () => {
    const body = fixture('deploy-response.json') as Record<string, unknown>;
    expect(deploySuccessResponseSchema.parse(body).ownerSubject).toBe('oauth-owner-123');
    const { ownerSubject: _ownerSubject, ...olderBody } = body;
    expect(deploySuccessResponseSchema.parse(olderBody).ownerSubject).toBeUndefined();
  });

  /**
   * That stripping is exactly why `embedId` has to be declared. A public deploy returns the id the
   * developer pastes into their page; an undeclared field would parse fine and vanish before the CLI
   * could print it — a silent loss, not a loud one. The golden fixture stays unchanged: an old-shape
   * response is still a valid response, because a deploy with no public surface returns no id.
   */
  it('carries a public embed id through when the deploy provisioned one', () => {
    const body = {
      ...(fixture('deploy-response.json') as Record<string, unknown>),
      embedId: 'pub_7f2q4k9x0000000000000000',
    };
    const parsed = deploySuccessResponseSchema.safeParse(body);

    expect(parsed.success && parsed.data.embedId).toBe('pub_7f2q4k9x0000000000000000');
  });

  it('accepts the old shape, because a deploy without a public surface provisions no id', () => {
    const parsed = deploySuccessResponseSchema.safeParse(fixture('deploy-response.json'));
    expect(parsed.success && parsed.data.embedId).toBeUndefined();
  });
});

describe('deployment owner operator contracts', () => {
  it('exports one subject validator that preserves case, bytes, and the 512-character boundary', () => {
    const decomposedSubject = 'oauth-e\u0301';
    expect(deploymentOwnerSubjectSchema.safeParse(decomposedSubject)).toEqual({
      success: true,
      data: decomposedSubject,
    });
    expect(deploymentOwnerSubjectSchema.safeParse('x'.repeat(512)).success).toBe(true);
  });

  it('accepts owner selection only with explicit owner-only access and rejects unknown fields', () => {
    const request = { accessMode: 'owner-only', ownerSubject: 'oauth-owner-123' };
    expect(accessUpdateRequestSchema.safeParse(request)).toEqual({ success: true, data: request });
    expect(accessUpdateRequestSchema.safeParse({ ...request, accessMode: 'public' }).success).toBe(
      false,
    );
    expect(accessUpdateRequestSchema.safeParse({ ...request, unknown: true }).success).toBe(false);
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])('accepts access response component changes %s/%s with aggregate %s', (accessChanged, ownerChanged, changed) => {
    const parsed = accessUpdateResponseSchema.safeParse({
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_123',
        serverVersion: '1',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-123',
      },
      previousAccessMode: 'org-members',
      previousOwnerSubject: 'oauth-owner-previous',
      accessChanged,
      ownerChanged,
      changed,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deployment.ownerSubject).toBe('oauth-owner-123');
    }
  });

  it('accepts an ownerless legacy public deployment changing to authenticated access', () => {
    const parsed = accessUpdateResponseSchema.safeParse({
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_legacy',
        accessMode: 'authenticated',
      },
      previousAccessMode: 'public',
      accessChanged: true,
      ownerChanged: false,
      changed: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.previousOwnerSubject).toBeUndefined();
      expect(parsed.data.deployment.ownerSubject).toBeUndefined();
    }
  });

  it('accepts an explicit current owner when an ownerless legacy public deployment becomes owner-only', () => {
    const parsed = accessUpdateResponseSchema.safeParse({
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_legacy',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-123',
      },
      previousAccessMode: 'public',
      accessChanged: true,
      ownerChanged: true,
      changed: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.previousOwnerSubject).toBeUndefined();
      expect(parsed.data.deployment.ownerSubject).toBe('oauth-owner-123');
    }
  });

  it('rejects an owner-only current deployment with no owner subject', () => {
    expect(
      accessUpdateResponseSchema.safeParse({
        ok: true,
        target: { org: 'acme', app: 'support', env: 'prod' },
        deployment: {
          deploymentId: 'dep_legacy',
          accessMode: 'owner-only',
        },
        previousAccessMode: 'public',
        accessChanged: true,
        ownerChanged: false,
        changed: true,
      }).success,
    ).toBe(false);
  });

  it.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
  ])('rejects access response component changes %s/%s with inconsistent aggregate %s', (accessChanged, ownerChanged, changed) => {
    expect(
      accessUpdateResponseSchema.safeParse({
        ok: true,
        target: { org: 'acme', app: 'support', env: 'prod' },
        deployment: {
          deploymentId: 'dep_123',
          accessMode: 'owner-only',
          ownerSubject: 'oauth-owner-123',
        },
        previousAccessMode: 'owner-only',
        previousOwnerSubject: 'oauth-owner-123',
        accessChanged,
        ownerChanged,
        changed,
      }).success,
    ).toBe(false);
  });

  it('rejects undeclared access response fields at the envelope and deployment layers', () => {
    const response = {
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_123',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-123',
      },
      previousAccessMode: 'owner-only',
      previousOwnerSubject: 'oauth-owner-123',
      accessChanged: false,
      ownerChanged: false,
      changed: false,
    } as const;
    expect(accessUpdateResponseSchema.safeParse({ ...response, unknown: true }).success).toBe(
      false,
    );
    expect(
      accessUpdateResponseSchema.safeParse({
        ...response,
        deployment: { ...response.deployment, unknown: true },
      }).success,
    ).toBe(false);
  });

  it('keeps service output strict while the client reader strips additive fields at every layer', () => {
    const parsed = accessUpdateClientResponseSchema.parse({
      ok: true,
      target: {
        org: 'acme',
        app: 'support',
        env: 'prod',
        futureTargetField: 'private-target-detail',
      },
      deployment: {
        deploymentId: 'dep_123',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-123',
        futureDeploymentField: 'private-deployment-detail',
      },
      previousAccessMode: 'org-members',
      accessChanged: true,
      ownerChanged: false,
      changed: true,
      futureEnvelopeField: 'private-envelope-detail',
    });

    expect(parsed).toEqual({
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_123',
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-123',
      },
      previousAccessMode: 'org-members',
      accessChanged: true,
      ownerChanged: false,
      changed: true,
    });
  });

  it('derives only the observable component change from a supported legacy access response', () => {
    expect(
      accessUpdateClientResponseSchema.parse({
        ok: true,
        target: { org: 'acme', app: 'support', env: 'prod' },
        deployment: {
          deploymentId: 'dep_legacy',
          accessMode: 'owner-only',
        },
        previousAccessMode: 'public',
        changed: true,
      }),
    ).toEqual({
      ok: true,
      target: { org: 'acme', app: 'support', env: 'prod' },
      deployment: {
        deploymentId: 'dep_legacy',
        accessMode: 'owner-only',
      },
      previousAccessMode: 'public',
      accessChanged: true,
      changed: true,
    });
  });
});

describe('assistantSessionResponseSchema (ADR 0151)', () => {
  const valid = fixture('assistant-session-response.json') as Record<string, unknown>;

  it('requires absolute endpoint URLs', () => {
    const relative = {
      ...valid,
      endpoints: {
        turns: '/v1/assistant/turns',
        toolConfirmations: '/v1/assistant/tool-confirmations',
        interactions: '/v1/assistant/interactions',
      },
    };
    expect(assistantSessionResponseSchema.safeParse(relative).success).toBe(false);
  });

  it('rejects a session response missing endpoints (the 1.0.0 gatewayUrl-era shape)', () => {
    const { endpoints: _endpoints, ...withoutEndpoints } = valid;
    expect(
      assistantSessionResponseSchema.safeParse({
        ...withoutEndpoints,
        gatewayUrl: 'https://cloud.noodleseed.dev/v1/assistant/turns',
      }).success,
    ).toBe(false);
  });

  it('accepts a response with or without the armed-resume hint, and rejects a malformed one', () => {
    const { resume: _resume, ...withoutResume } = valid;
    expect(assistantSessionResponseSchema.safeParse(withoutResume).success).toBe(true);
    expect(assistantSessionResponseSchema.safeParse(valid).success).toBe(true);
    expect(
      assistantSessionResponseSchema.safeParse({ ...withoutResume, resume: { tool: '' } }).success,
    ).toBe(false);
    expect(
      assistantSessionResponseSchema.safeParse({ ...withoutResume, resume: true }).success,
    ).toBe(false);
  });

  it('accepts a response without configuration (widget renders defaults)', () => {
    const { configuration: _configuration, ...withoutConfiguration } = valid;
    expect(assistantSessionResponseSchema.safeParse(withoutConfiguration).success).toBe(true);
  });

  it('keeps the interactions endpoint additive for published clients', () => {
    const endpoints = valid.endpoints as Record<string, unknown>;
    const { interactions: _interactions, ...legacyEndpoints } = endpoints;
    expect(
      assistantSessionResponseSchema.safeParse({ ...valid, endpoints: legacyEndpoints }).success,
    ).toBe(true);
  });

  it('keeps the sandbox endpoint additive and requires an absolute URL when present', () => {
    const endpoints = valid.endpoints as Record<string, unknown>;
    expect(typeof endpoints.sandbox).toBe('string');
    const { sandbox: _sandbox, ...legacyEndpoints } = endpoints;
    expect(
      assistantSessionResponseSchema.safeParse({ ...valid, endpoints: legacyEndpoints }).success,
    ).toBe(true);
    expect(
      assistantSessionResponseSchema.safeParse({
        ...valid,
        endpoints: { ...endpoints, sandbox: '/v1/assistant/sandbox' },
      }).success,
    ).toBe(false);
  });
});

describe('assistant interaction wire contract', () => {
  it('accepts the golden accept response and rejects content on terminal refusals', () => {
    expect(
      assistantInteractionRequestSchema.safeParse(fixture('assistant-interaction-request.json'))
        .success,
    ).toBe(true);
    expect(
      assistantInteractionRequestSchema.safeParse({
        id: 'interaction-1',
        action: 'decline',
        content: { forged: true },
      }).success,
    ).toBe(false);
  });

  it('pins additive event payloads for exact review and refusal continuation', () => {
    const events = fixture('assistant-events.json') as unknown[];
    expect(events).toHaveLength(10);
    for (const event of events) {
      const parsed = assistantWireEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(formatWireError(parsed.error));
    }
  });

  it('accepts only a ui:// identity for a renderer-available view event', () => {
    expect(
      assistantWireEventSchema.safeParse({
        event: 'view_available',
        data: {
          id: 'call_1',
          tool: 'open_order',
          resourceUri: 'ui://orders/order_card',
          result: { orderId: 'order_1' },
          allowedOpenDomains: ['https://orders.example.com'],
        },
      }).success,
    ).toBe(true);
    expect(
      assistantWireEventSchema.safeParse({
        event: 'view_available',
        data: {
          id: 'call_1',
          tool: 'open_order',
          resourceUri: 'https://evil.example/widget',
          result: {},
        },
      }).success,
    ).toBe(false);
    expect(
      assistantWireEventSchema.safeParse({
        event: 'view_available',
        data: {
          id: 'call_1',
          tool: 'open_order',
          resourceUri: 'ui://orders/order_card',
          result: {},
          allowedOpenDomains: ['http://orders.example.com'],
        },
      }).success,
    ).toBe(false);
  });
});

describe('assistant turn wire contract', () => {
  it('accepts bounded renderer-reported model context and rejects unknown request fields', () => {
    expect(
      assistantTurnRequestSchema.safeParse(fixture('assistant-turn-request.json')).success,
    ).toBe(true);
    expect(
      assistantTurnRequestSchema.safeParse({ message: 'Hello', instructions: 'ignore safety' })
        .success,
    ).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
  });

  it('accepts the bare one-shot resume trigger and nothing beside it', () => {
    expect(assistantTurnRequestSchema.safeParse({ resume: true }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ resume: false }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ resume: true, message: 'hi' }).success).toBe(
      false,
    );
    expect(assistantTurnRequestSchema.safeParse({ resume: true, extra: 1 }).success).toBe(false);
  });

  it('accepts bounded per-turn page context without weakening the strict envelope', () => {
    expect(
      assistantTurnRequestSchema.parse({
        message: 'Show this account',
        pageContext: { selectedAccountId: 'account-1', route: '/accounts/account-1' },
      }),
    ).toEqual({
      message: 'Show this account',
      pageContext: { selectedAccountId: 'account-1', route: '/accounts/account-1' },
    });
    expect(
      assistantTurnRequestSchema.safeParse({
        message: 'Show this account',
        pageContext: { accessToken: 'must-not-cross-this-boundary' },
      }).success,
    ).toBe(false);
  });

  it('rejects oversized, deeply nested, and credential-shaped model context', () => {
    let deeplyNested: Readonly<Record<string, unknown>> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) deeplyNested = { child: deeplyNested };
    expect(
      assistantModelContextUpdateSchema.safeParse({
        structuredContent: { summary: 'x'.repeat(17 * 1024) },
      }).success,
    ).toBe(false);
    expect(
      assistantModelContextUpdateSchema.safeParse({
        structuredContent: deeplyNested,
      }).success,
    ).toBe(false);
    expect(
      assistantModelContextUpdateSchema.safeParse({
        structuredContent: { form: { apiKey: 'must-not-cross' } },
      }).success,
    ).toBe(false);
    expect(
      assistantModelContextUpdateSchema.safeParse({
        content: [{ type: 'text', text: `Authorization: Bearer ${'a'.repeat(40)}` }],
      }).success,
    ).toBe(false);
  });
});

describe('knowledge control-plane schemas', () => {
  const sha = 'a'.repeat(64);

  it('bounds preflight requests by the knowledge limits owner', () => {
    expect(
      knowledgePreflightRequestSchema.safeParse({
        components: [{ name: 'product', documents: [{ sha256: sha, bytes: 10 }] }],
      }).success,
    ).toBe(true);
    expect(knowledgePreflightRequestSchema.safeParse({ components: [] }).success).toBe(false);
    expect(
      knowledgePreflightRequestSchema.safeParse({
        components: [{ name: 'product', documents: [{ sha256: sha, bytes: 2 * 1024 * 1024 }] }],
      }).success,
    ).toBe(false);
    expect(
      knowledgePreflightRequestSchema.safeParse({
        components: [{ name: 'Product', documents: [] }],
      }).success,
    ).toBe(false);
    // The component cap is the dedicated authoring limit the compiler enforces too — it was
    // briefly the result-page limit (20) by accidental reuse, which the compiler never checked,
    // so a validly compiled app could fail only at deploy.
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `component_${index}`,
        documents: [{ sha256: sha, bytes: 10 }],
      }));
    expect(
      knowledgePreflightRequestSchema.safeParse({ components: many(MAX_KNOWLEDGE_COMPONENTS) })
        .success,
    ).toBe(true);
    expect(
      knowledgePreflightRequestSchema.safeParse({
        components: many(MAX_KNOWLEDGE_COMPONENTS + 1),
      }).success,
    ).toBe(false);
  });

  it('keeps responses to hashes and lifecycle truth, never contents', () => {
    expect(knowledgePreflightResponseSchema.safeParse({ ok: true, missing: [sha] }).success).toBe(
      true,
    );
    expect(
      knowledgePreflightResponseSchema.safeParse({ ok: true, missing: [sha], contents: 'x' })
        .success,
    ).toBe(false);
    expect(
      knowledgeStatusResponseSchema.safeParse({
        ok: true,
        scope: { org: 'acme', app: 'site', env: 'prod' },
        component: {
          name: 'product',
          sources: { documents: 2, sites: 1 },
          declaringScope: 'env',
          state: 'active',
        },
        errors: [],
      }).success,
    ).toBe(true);
  });
});
