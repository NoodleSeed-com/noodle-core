import { describe, expect, it } from 'vitest';
import { ChannelCoordinator } from '../src/channel-coordinator.js';
import { InMemoryChannelStore } from '../src/channel-store.js';
import { PostgresChannelStore } from '../src/postgres-channel-store.js';
import { isolatedPostgres } from './isolated-postgres.js';

const tenant = { org: 'org', app: 'site', env: 'production' };
const configure = {
  tenant,
  phoneNumberId: 'phone-1',
  apiKeySecret: 'WHATSAPP_API_KEY',
  webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
  deploymentId: 'deploy-1',
  capabilities: [{ kind: 'tool' as const, name: 'site_identity' }],
  supportEmail: 'hello@noodleseed.com',
};
const url = process.env.DATABASE_URL_TEST;
const pool = url ? isolatedPostgres(url) : undefined;
for (const durable of [false, true]) {
  describe.runIf(!durable || !!pool)(
    `channel lifecycle (${durable ? 'postgres' : 'memory'})`,
    () => {
      async function setup() {
        const store = durable
          ? new PostgresChannelStore(pool!, {
              seal: async (scope, id, value) => ({ scope, id, value }),
              open: async (scope, id, sealed) => {
                const envelope = sealed as { scope: string; id: string; value: unknown };
                if (scope !== envelope.scope || id !== envelope.id)
                  throw new Error('cipher binding');
                return envelope.value;
              },
            })
          : new InMemoryChannelStore();
        if (store instanceof PostgresChannelStore) await store.ensureSchema();
        let now = 1_800_000_000_000;
        const channels = new ChannelCoordinator(store, () => now);
        const unique = crypto.randomUUID();
        const binding = await channels.configure(
          { ...configure, tenant: { ...tenant, app: unique }, phoneNumberId: unique },
          'operator',
          'create',
          0,
        );
        return {
          channels,
          binding,
          advance: (ms: number) => {
            now += ms;
          },
          now: () => now,
        };
      }
      it('creates paused, requires readiness, rejects stale mutations and duplicate provider ownership', async () => {
        const { channels, binding } = await setup();
        expect(binding.state).toBe('paused');
        expect(binding).not.toHaveProperty('indexKey');
        await expect(
          channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision),
        ).rejects.toMatchObject({ code: 'not_ready' });
        await channels.markReady(binding.id, binding.revision);
        const enabled = await channels.setState(
          binding.id,
          'enabled',
          'operator',
          'enable',
          binding.revision,
        );
        expect(enabled.state).toBe('enabled');
        expect(
          await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision),
        ).toEqual(enabled);
        await expect(
          channels.setState(binding.id, 'paused', 'operator', 'stale', binding.revision),
        ).rejects.toMatchObject({ code: 'revision_conflict' });
        await expect(
          channels.configure(
            {
              ...configure,
              phoneNumberId: binding.phoneNumberId,
              tenant: { ...tenant, app: crypto.randomUUID() },
            },
            'operator',
            'create',
            0,
          ),
        ).rejects.toMatchObject({ code: 'asset_in_use' });
      });
      it('finds a number owner across providers and keeps each provider to its own credentials', async () => {
        const { channels, binding } = await setup();
        expect(binding.provider).toBe('360dialog');
        expect(binding).not.toHaveProperty('wabaId');
        expect(await channels.bindingForAsset(binding.phoneNumberId)).toBe(binding.id);
        expect(await channels.bindingForAsset(crypto.randomUUID())).toBeUndefined();
        const { webhookSecret: _callback, ...metaInput } = configure;
        const meta = await channels.configure(
          {
            ...metaInput,
            tenant: binding.tenant,
            provider: 'meta',
            phoneNumberId: binding.phoneNumberId,
            wabaId: 'waba-1',
            apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
          },
          'operator',
          'to-meta',
          binding.revision,
        );
        expect(meta).toMatchObject({ id: binding.id, provider: 'meta', wabaId: 'waba-1' });
        expect(meta).not.toHaveProperty('webhookSecret');
        await expect(
          channels.configure(
            { ...metaInput, tenant: { ...tenant, app: crypto.randomUUID() }, provider: 'meta' },
            'operator',
            'no-waba',
            0,
          ),
        ).rejects.toMatchObject({ code: 'provider_configuration_invalid' });
        await expect(
          channels.configure(
            { ...configure, tenant: { ...tenant, app: crypto.randomUUID() }, wabaId: 'waba-1' },
            'operator',
            'stray-waba',
            0,
          ),
        ).rejects.toMatchObject({ code: 'provider_configuration_invalid' });
        await channels.setState(meta.id, 'disconnected', 'operator', 'disconnect', meta.revision);
        expect(await channels.bindingForAsset(binding.phoneNumberId)).toBeUndefined();
      });
      it('deduplicates admission, fences workers and keeps one participant ordered', async () => {
        const { channels, binding, now, advance } = await setup();
        await channels.markReady(binding.id, binding.revision);
        await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
        const inbound = {
          providerId: 'message-1',
          address: { kind: 'phone' as const, value: '15551112222' },
          eventAt: now(),
          text: 'What is Noodle Seed?',
        };
        const first = await channels.receive(binding.id, [
          inbound,
          { ...inbound, providerId: 'message-2', text: 'Tell me more' },
        ]);
        expect((await channels.receive(binding.id, [inbound]))[0]).toEqual(first[0]);
        const turn = await channels.claim(binding.id);
        expect(turn?.event.text).toBe(inbound.text);
        expect(await channels.claim(binding.id)).toBeUndefined();
        advance(31_000);
        const recovered = await channels.claim(binding.id);
        expect(recovered?.event.id).toBe(turn?.event.id);
        await expect(
          channels.complete(binding.id, turn!.event.id, turn!.event.lease!, 'stale reply'),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await channels.complete(
          binding.id,
          recovered!.event.id,
          recovered!.event.lease!,
          'A business assistant platform.',
        );
        const send = await channels.prepareSend(binding.id);
        expect(send?.event.reply).toBe('A business assistant platform.');
        advance(31_000);
        expect(await channels.prepareSend(binding.id)).toBeUndefined();
        expect(
          (await channels.events(binding.id)).find((e) => e.id === turn!.event.id)?.state,
        ).toBe('unknown');
        expect((await channels.claim(binding.id))?.event.text).toBe('Tell me more');
      });
      it('enforces atomic sender limits and preserves blocks across pause/reconfigure', async () => {
        const { channels, binding, now } = await setup();
        await channels.markReady(binding.id, binding.revision);
        const enabled = await channels.setState(
          binding.id,
          'enabled',
          'operator',
          'enable',
          binding.revision,
        );
        const address = { kind: 'phone' as const, value: '15551112222' };
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            channels.receive(binding.id, [
              { address, providerId: `m${i}`, eventAt: now(), text: 'Hi' },
            ]),
          ),
        );
        expect(results.flat().filter((x) => x.state === 'queued')).toHaveLength(3);
        const participantId = results[0]![0]!.participantId;
        await channels.block(binding.id, participantId, 'operator', 'block', now() + 86_400_000);
        await channels.setState(binding.id, 'paused', 'operator', 'pause', enabled.revision);
        expect((await channels.blocks(binding.id))[0]?.participantId).toBe(participantId);
        const blocked = await channels.receive(binding.id, [
          { address, providerId: 'blocked', eventAt: now(), text: 'Do not store this' },
        ]);
        expect(blocked[0]).not.toHaveProperty('text');
        expect(blocked[0]?.state).toBe('refused');
      });
      it('rolls back rejected registration and keeps per-conversation tool claims across messages', async () => {
        const { channels, binding, now } = await setup();
        const other = { ...tenant, app: crypto.randomUUID() };
        await expect(
          channels.configure(
            { ...configure, tenant: other, phoneNumberId: binding.phoneNumberId },
            'operator',
            'collision',
            0,
          ),
        ).rejects.toMatchObject({ code: 'asset_in_use' });
        expect(await channels.get(other)).toBeUndefined();
        await channels.markReady(binding.id, binding.revision);
        await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
        const inbound = {
          providerId: 'first',
          address: { kind: 'phone' as const, value: '15551112222' },
          eventAt: now(),
          text: 'Hi',
        };
        const [receipt] = await channels.receive(binding.id, [inbound]);
        expect(await channels.claimTool(binding.id, receipt!.participantId, 'once')).toBe(true);
        await channels.receive(binding.id, [{ ...inbound, providerId: 'second' }]);
        expect(await channels.claimTool(binding.id, receipt!.participantId, 'once')).toBe(false);
      });
      it('cools down repeated minute-limit abuse without counting retries twice', async () => {
        const { channels, binding, now, advance } = await setup();
        const limited = await channels.updateLimits(
          binding.id,
          { perMinute: 1 },
          'operator',
          'limits',
          binding.revision,
        );
        await channels.markReady(binding.id, limited.revision);
        await channels.setState(binding.id, 'enabled', 'operator', 'enable', limited.revision);
        const inbound = {
          providerId: 'first',
          address: { kind: 'phone' as const, value: '15551112222' },
          eventAt: now(),
          text: 'Hi',
        };
        const [receipt] = await channels.receive(binding.id, [inbound]);
        for (const providerId of ['second', 'second', 'third', 'fourth'])
          await channels.receive(binding.id, [{ ...inbound, providerId }]);
        expect((await channels.cooldown(binding.id, receipt!.participantId)).until).toBe(
          now() + 600_000,
        );
        advance(60_000);
        expect(
          (
            await channels.receive(binding.id, [
              { ...inbound, providerId: 'fifth', eventAt: now() },
            ])
          )[0]?.code,
        ).toBe('cooldown');
      });
      it('requires configuration to reclaim a disconnected asset and fences changed credentials', async () => {
        const { channels, binding } = await setup();
        await channels.checkCredentials(binding.id, 'first');
        await channels.markReady(binding.id, binding.revision);
        const live = await channels.setState(
          binding.id,
          'enabled',
          'operator',
          'enable',
          binding.revision,
        );
        await expect(channels.checkCredentials(binding.id, 'rotated')).rejects.toMatchObject({
          code: 'credentials_changed',
        });
        const paused = await channels.internal(binding.id);
        expect(paused.state).toBe('paused');
        expect(paused.generation).toBe(live.generation + 1);
        const disconnected = await channels.setState(
          binding.id,
          'disconnected',
          'operator',
          'disconnect',
          paused.revision,
        );
        await channels.configure(
          {
            ...configure,
            tenant: { ...tenant, app: crypto.randomUUID() },
            phoneNumberId: binding.phoneNumberId,
          },
          'other',
          'claim',
          0,
        );
        await channels.markReady(binding.id, disconnected.revision);
        await expect(
          channels.setState(binding.id, 'enabled', 'operator', 're-enable', disconnected.revision),
        ).rejects.toMatchObject({ code: 'asset_not_owned' });
      });
      it('enforces the total turn deadline and erases history independently of usage evidence', async () => {
        const { channels, binding, now, advance } = await setup();
        await channels.markReady(binding.id, binding.revision);
        await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
        await channels.receive(binding.id, [
          {
            providerId: 'deadline',
            address: { kind: 'phone', value: '15551112222' },
            eventAt: now(),
            text: 'Private content',
          },
        ]);
        const work = (await channels.claim(binding.id))!;
        advance(20_000);
        await channels.renew(binding.id, work.event.id, work.event.lease!);
        advance(20_000);
        await channels.renew(binding.id, work.event.id, work.event.lease!);
        advance(20_000);
        await expect(
          channels.complete(binding.id, work.event.id, work.event.lease!, 'Late'),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        await channels.reserveSpend(binding.id, 'unknown', 1000);
        advance(1000);
        await channels.expireHistory(binding.id, 60_000);
        expect(await channels.event(binding.id, work.event.id)).not.toHaveProperty('text');
        expect((await channels.usage(binding.id)).reservedMicroUsd).toBe(1000);
      });
      it('reserves spend atomically, retains unknown usage and settles idempotently', async () => {
        const { channels, binding } = await setup();
        await channels.markReady(binding.id, binding.revision);
        await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
        const results = await Promise.allSettled([
          channels.reserveSpend(binding.id, 'a', 12_000_000),
          channels.reserveSpend(binding.id, 'b', 12_000_000),
        ]);
        expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
        const attempt = results[0]?.status === 'fulfilled' ? 'a' : 'b';
        await channels.settleSpend(binding.id, attempt, 1000);
        await channels.settleSpend(binding.id, attempt, 1000);
        expect((await channels.usage(binding.id)).spentMicroUsd).toBe(1000);
        await channels.reserveSpend(binding.id, 'c', 12_000_000);
        expect((await channels.usage(binding.id)).reservedMicroUsd).toBe(12_000_000);
      });
    },
  );
}
