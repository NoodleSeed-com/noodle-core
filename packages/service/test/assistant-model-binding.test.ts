import type { ServedTarget } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { resolveAssistantModelBinding } from '../src/routes/assistant-model-binding.js';

describe('assistant model binding', () => {
  it('carries the deployment-selected Responses transport into the resolved binding', async () => {
    const target = {
      served: {
        artifact: {
          server: {
            assistant: {
              model: {
                kind: 'openai-compatible',
                transport: 'responses',
                baseUrl: '${env.MODEL_URL}',
                model: '${env.MODEL_NAME}',
                apiKey: 'MODEL_KEY',
              },
            },
          },
        },
      },
    } as ServedTarget;
    const resolveConfigValues = vi.fn(async (kind: 'variable' | 'secret') =>
      kind === 'variable'
        ? { MODEL_URL: 'https://models.example/v1', MODEL_NAME: 'responses-model' }
        : { MODEL_KEY: 'operator-secret' },
    );

    await expect(
      resolveAssistantModelBinding(target, { org: 'acme', app: 'support', env: 'prod' }, 'dep_1', {
        registry: { configStore: { resolveConfigValues } },
      } as unknown as AssistantRouteDeps),
    ).resolves.toMatchObject({
      source: 'operator',
      transport: 'responses',
      baseUrl: 'https://models.example/v1',
      model: 'responses-model',
    });
  });

  it('resolves noodle-managed declarations only through the injected hosted operator port', async () => {
    const resolve = vi.fn(async () => ({
      source: 'noodle-managed' as const,
      baseUrl: 'https://models.example/v1',
      model: 'private-model',
      apiKey: 'operator-secret',
    }));
    const target = {
      served: {
        artifact: { server: { assistant: { model: { kind: 'noodle-managed' } } } },
      },
    } as ServedTarget;
    const tenant = { org: 'acme', app: 'support', env: 'prod' };

    await expect(
      resolveAssistantModelBinding(target, tenant, 'dep_1', {
        managedModelResolver: { resolve },
      } as AssistantRouteDeps),
    ).resolves.toMatchObject({ source: 'noodle-managed', model: 'private-model' });
    expect(resolve).toHaveBeenCalledWith({ tenant, deploymentId: 'dep_1' });
  });

  it('fails closed when the target is not in the managed beta cohort', async () => {
    const target = {
      served: {
        artifact: { server: { assistant: { model: { kind: 'noodle-managed' } } } },
      },
    } as ServedTarget;
    await expect(
      resolveAssistantModelBinding(target, { org: 'other', app: 'support', env: 'prod' }, 'dep_1', {
        managedModelResolver: { resolve: async () => undefined },
      } as AssistantRouteDeps),
    ).resolves.toBeUndefined();
  });
});
