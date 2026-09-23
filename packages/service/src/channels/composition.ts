import { PostgresChannelStore } from '@noodle-borg/assistant-gateway/postgres';
import type { ResolveActivityHistoryAllowance } from '@noodle-borg/module';
import type { SecretBox } from '@noodle-borg/runtime';
import { noopLogger } from '@noodle-borg/transport-http';
import type { Pool } from 'pg';
import type { ApplicationActivity } from '../application-activity.js';
import type { BusinessInformationStore } from '../business-information/contracts.js';
import type { ServiceOptions } from '../options.js';
import type { AssistantRouteDeps } from '../routes/assistant.js';
import { ChannelSecretBoxCipher } from './cipher.js';
import { WhatsAppRuntime, type WhatsAppServiceOptions } from './runtime.js';
import { ChannelWorkerLoop } from './worker-loop.js';

export async function createPostgresWhatsApp(
  pool: Pool,
  secretBox: SecretBox | undefined,
  options: ServiceOptions,
): Promise<WhatsAppServiceOptions> {
  if (!secretBox) throw new Error('WhatsApp storage requires the service key custodian');
  const store = new PostgresChannelStore(pool, new ChannelSecretBoxCipher(secretBox));
  await store.ensureSchema();
  return {
    store,
    worker: new ChannelWorkerLoop((code) =>
      (options.logger ?? noopLogger).warn('assistant.channel.worker', { code }),
    ),
    ...(options.whatsappMeta ? { meta: options.whatsappMeta } : {}),
  };
}
export function createWhatsAppRuntime(
  options: WhatsAppServiceOptions | undefined,
  deps: AssistantRouteDeps,
  history: {
    readonly allowance: ResolveActivityHistoryAllowance | undefined;
    readonly installations: BusinessInformationStore | undefined;
    readonly activity: ApplicationActivity | undefined;
  },
) {
  if (!options) return undefined;
  return new WhatsAppRuntime(
    {
      ...options,
      ...(history.installations ? { installations: history.installations } : {}),
      ...(history.allowance
        ? {
            historyDays: async (tenant: import('../store.js').TenantRef) => {
              const allowance = await history.allowance?.(tenant.org);
              if (!allowance) throw new Error('history policy unavailable');
              const installation = (
                await history.installations?.listInstallations(tenant.org)
              )?.find((item) => item.scope.app === tenant.app && item.scope.env === tenant.env);
              return installation && history.activity
                ? Math.min(
                    allowance.maximumDays,
                    (await history.activity.settings(installation.scope, false)).projection.activity
                      .retentionDays,
                  )
                : allowance.maximumDays;
            },
          }
        : {}),
    },
    deps,
  );
}
