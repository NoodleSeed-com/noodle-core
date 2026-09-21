import type { IncomingMessage } from 'node:http';
import {
  beginChannelProviderBlock,
  CHANNEL_RETENTION_MS,
  type ChannelBinding,
  ChannelCoordinator,
  ChannelError,
  type ChannelStore,
  type ChannelWork,
  channelDigest,
  channelProviderBlocks,
  collectionSpecFor,
  finishChannelProviderBlock,
  type MessagingTurnContext,
  messagingSurfaceOf,
  projectArtifactForSurface,
  resolveInvocationContextSnapshot,
  WHATSAPP_CONFIRMATION_EXPIRY_MS,
  withAssistantTurnExecutionAuthority,
} from '@noodle-borg/assistant-gateway/portable';
import { guardedFetch } from '@noodle-borg/connector-http';
import { executePreparedTool, prepareToolForConfirmation } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import type { AssistantRouteDeps } from '../routes/assistant.js';
import { runAgentTurn } from '../routes/assistant-agent.js';
import { resolveAssistantKnowledge } from '../routes/assistant-knowledge.js';
import { resolveAssistantModelBinding } from '../routes/assistant-model-binding.js';
import { activeAssistantTarget } from '../routes/assistant-session-target.js';
import { resolveConfigScope } from '../store.js';
import { Dialog360, verifyWhatsAppWebhookSecret, WHATSAPP_CALLBACK_HEADER } from './360dialog.js';
import { type CapabilityInstallations, capabilityReport } from './capability-report.js';
import {
  type CollectionTurnOutcome,
  collectionCustody,
  messagingAdmissionDigest,
  redactPrivate,
  runCollectionTurn,
} from './collection-turn.js';
import { verifiedInferenceBound, withChannelInferenceGuard } from './inference-guard.js';
import { messagingProjectionIneligibility } from './messaging-eligibility.js';
import { reviewButtonBinding } from './reply-buttons.js';
import type { ChannelWorkerLoop } from './worker-loop.js';

export interface WhatsAppServiceOptions {
  readonly store: ChannelStore;
  readonly worker: ChannelWorkerLoop;
  readonly providerFetch?: typeof fetch;
  readonly historyDays?: (tenant: ChannelBinding['tenant']) => Promise<number>;
  /** Installed collections, read only to report whether a selected collect action is set up. */
  readonly installations?: CapabilityInstallations;
}
export class WhatsAppRuntime {
  readonly channels: ChannelCoordinator;
  private cursor: string | undefined;
  constructor(
    readonly options: WhatsAppServiceOptions,
    readonly deps: AssistantRouteDeps,
  ) {
    this.channels = new ChannelCoordinator(
      options.store,
      () => deps.clock?.().getTime() ?? Date.now(),
    );
    options.worker.attach(() => this.sweep());
  }
  async provider(binding: ChannelBinding): Promise<{ adapter: Dialog360; webhookSecret: string }> {
    const values = await this.deps.registry.configStore.resolveConfigValues(
      'secret',
      resolveConfigScope(binding.tenant),
    );
    const apiKey = values[binding.apiKeySecret],
      webhookSecret = values[binding.webhookSecret];
    if (
      !apiKey ||
      !webhookSecret ||
      apiKey === webhookSecret ||
      !verifyWhatsAppWebhookSecret(webhookSecret, webhookSecret)
    )
      throw new ChannelError('channel_credentials_missing');
    await this.channels.checkCredentials(
      binding.id,
      channelDigest(JSON.stringify([apiKey, webhookSecret])),
    );
    return { adapter: new Dialog360(apiKey, this.options.providerFetch), webhookSecret };
  }
  webhookUrl(req: IncomingMessage, binding: ChannelBinding): string {
    return `${this.deps.serviceBase(req).replace(/\/$/, '')}/v1/channels/whatsapp/webhooks/${binding.id}`;
  }
  async target(binding: ChannelBinding): Promise<ServedTarget> {
    const target = await activeAssistantTarget(this.deps, binding.tenant);
    if (!target || target.deploymentId !== binding.deploymentId)
      throw new ChannelError('deployment_changed');
    const surface = messagingSurfaceOf(target.served.artifact.server.assistant);
    if (!surface) throw new ChannelError('messaging_surface_missing');
    if (
      binding.capabilities.some(
        (cap) =>
          !surface.capabilities.some(
            (authored) => authored.kind === cap.kind && authored.name === cap.name,
          ),
      )
    )
      throw new ChannelError('capability_not_authored');
    const artifact = projectArtifactForSurface(target.served.artifact, binding.capabilities);
    const ineligible = messagingProjectionIneligibility(artifact);
    if (ineligible !== undefined) throw new ChannelError(ineligible);
    return { ...target, served: { ...target.served, artifact } };
  }
  async doctor(id: string, req: IncomingMessage) {
    const binding = await this.channels.internal(id);
    const checks: Array<{ name: string; status: 'ready' | 'unavailable'; code?: string }> = [];
    const check = async (name: string, work: () => Promise<string | void>) => {
      try {
        const code = await work();
        checks.push({ name, status: 'ready', ...(code ? { code } : {}) });
      } catch (error) {
        checks.push({
          name,
          status: 'unavailable',
          code: error instanceof ChannelError ? error.code : 'check_unavailable',
        });
      }
    };
    await check('durability', async () => {
      if (!this.options.store.durable) throw new ChannelError('durable_storage_required');
    });
    await check('worker', async () => {
      if (!this.options.worker.ready()) throw new ChannelError('worker_unavailable');
    });
    let target: ServedTarget | undefined;
    await check('deployment', async () => {
      target = await this.target(binding);
    });
    await check('model_cost', async () => {
      const model = await resolveAssistantModelBinding(
        await this.target(binding),
        binding.tenant,
        binding.deploymentId,
        this.deps,
        'whatsapp',
      );
      if (!model) throw new ChannelError('model_not_configured');
      verifiedInferenceBound(model, this.channels.now());
    });
    await check('history_policy', async () => {
      await this.retention(binding);
    });
    await check('knowledge', async () => {
      const target = await this.target(binding);
      if (
        (target.served.artifact.server.knowledge?.length ?? 0) > 0 &&
        !(await resolveAssistantKnowledge(target.served))
      )
        throw new ChannelError('knowledge_unavailable');
    });
    await check('provider_asset', async () => {
      const health = await (await this.provider(binding)).adapter.health();
      if (health.phoneNumberId !== binding.phoneNumberId) throw new ChannelError('asset_mismatch');
      if (!health.canSend) throw new ChannelError('provider_messaging_blocked');
      return health.status === 'LIMITED' ? 'provider_messaging_limited' : undefined;
    });
    await check('webhook', async () => {
      const state = await this.webhook(id, req);
      if (!state.matches || !state.authenticated) throw new ChannelError('webhook_not_configured');
    });
    const ready = checks.every((check) => check.status === 'ready');
    if (ready) await this.channels.markReady(id, binding.revision);
    // The compatibility report rides beside readiness and never changes it (ADR 0240 decision 7).
    const capabilities = await capabilityReport({
      artifact: target?.served.artifact,
      tenant: binding.tenant,
      durable: this.options.store.durable,
      installations: this.options.installations,
    });
    return {
      ready,
      revision: binding.revision,
      checks,
      capabilities,
      webhookUrl: this.webhookUrl(req, binding),
    };
  }
  async webhook(id: string, req: IncomingMessage) {
    const binding = await this.channels.internal(id);
    const { adapter, webhookSecret } = await this.provider(binding);
    const current = await adapter.webhook();
    return {
      url: this.webhookUrl(req, binding),
      matches: current.url === this.webhookUrl(req, binding),
      authenticated: verifyWhatsAppWebhookSecret(
        current.headers?.[WHATSAPP_CALLBACK_HEADER],
        webhookSecret,
      ),
    };
  }
  async configureWebhook(id: string, req: IncomingMessage): Promise<void> {
    const binding = await this.channels.internal(id);
    if (binding.state !== 'paused') throw new ChannelError('pause_before_webhook_change');
    const { adapter, webhookSecret } = await this.provider(binding);
    const existing = await adapter.webhook();
    const url = this.webhookUrl(req, binding);
    if (existing.url && existing.url !== url) throw new ChannelError('webhook_ownership_conflict');
    if (
      existing.url !== url ||
      !verifyWhatsAppWebhookSecret(existing.headers?.[WHATSAPP_CALLBACK_HEADER], webhookSecret)
    )
      await adapter.configureWebhook(url, webhookSecret);
  }
  async projection(tenant: ChannelBinding['tenant']) {
    const binding = await this.channels.get(tenant);
    if (!binding)
      return {
        status: 'unavailable' as const,
        capabilities: [],
        reason: 'WhatsApp is not configured.',
      };
    const view = {
      bindingId: binding.id,
      revision: binding.revision,
      capabilities: binding.capabilities.map((cap) => `${cap.kind}:${cap.name}`),
    };
    if (binding.state !== 'enabled') return { ...view, status: 'paused' as const };
    try {
      await this.target(await this.channels.internal(binding.id));
      return { ...view, status: 'ready' as const };
    } catch {
      return {
        ...view,
        status: 'unavailable' as const,
        reason: 'The active deployment or installation is unavailable.',
      };
    }
  }
  async providerBlock(
    id: string,
    participantId: string,
    blocked: boolean,
    actor: string,
    key: string,
    protectedPhone?: string,
  ): Promise<void> {
    const operation = await beginChannelProviderBlock(
      this.channels.store,
      id,
      participantId,
      blocked ? 'blocked' : 'unblocked',
      actor,
      key,
      this.channels.now(),
      protectedPhone,
    );
    if (!operation) return;
    try {
      const binding = await this.channels.internal(id);
      if (binding.generation !== operation.generation) throw new ChannelError('authority_changed');
      const { adapter } = await this.provider(binding);
      const result = await adapter.setBlocked(operation.address.value, blocked);
      await finishChannelProviderBlock(
        this.channels.store,
        id,
        participantId,
        operation.revision,
        result.state,
        this.channels.now(),
        result.code,
      );
    } catch {
      await finishChannelProviderBlock(
        this.channels.store,
        id,
        participantId,
        operation.revision,
        'unknown',
        this.channels.now(),
        'provider_outcome_unknown',
      );
    }
  }
  async blocks(id: string, after?: string) {
    const local = await this.channels.blocks(id, after);
    const provider = await channelProviderBlocks(
      this.channels.store,
      id,
      this.channels.now(),
      after,
    );
    const ids = [
      ...new Set([
        ...local.map((item) => item.participantId),
        ...provider.map((item) => item.participantId),
      ]),
    ];
    const data = ids
      .sort()
      .slice(0, 100)
      .map((participantId) => {
        const block = local.find((item) => item.participantId === participantId);
        const match = provider.find((item) => item.participantId === participantId);
        return {
          ...(block ?? {
            participantId,
            actor: match!.actor,
            reason: 'operator' as const,
            until: null,
          }),
          local: !!block && (block.until === null || block.until > this.channels.now()),
          ...(match
            ? {
                provider: {
                  desired: match.desired,
                  state: match.state,
                  updatedAt: match.updatedAt,
                  ...(match.code ? { code: match.code } : {}),
                },
              }
            : {}),
        };
      });
    return { data, ...(data.length === 100 ? { next: data.at(-1)!.participantId } : {}) };
  }

  async retention(binding: ChannelBinding): Promise<number> {
    const days = (await this.options.historyDays?.(binding.tenant)) ?? 7;
    if (!Number.isInteger(days) || days < 1) throw new ChannelError('history_policy_unavailable');
    return Math.min(CHANNEL_RETENTION_MS, days * 86_400_000);
  }
  async sweep(): Promise<void> {
    const page = await this.channels.bindingPage(this.cursor);
    this.cursor = page.after;
    // Bounded parallelism and rotating registry pages prevent a busy tenant starving later ones.
    for (let offset = 0; offset < page.ids.length; offset += 5) {
      await Promise.all(page.ids.slice(offset, offset + 5).map((id) => this.process(id)));
    }
    await this.options.store.prune(this.channels.now(), 1000);
  }
  private async process(id: string): Promise<void> {
    try {
      if (this.options.worker.signal.aborted) return;
      const binding = await this.channels.internal(id);
      const retention = await this.retention(binding);
      await this.channels.expireHistory(id, retention);
      const work = await this.channels.claim(id, retention);
      if (work) await this.answer(work);
      for (let n = 0; n < 5 && !this.options.worker.signal.aborted; n++) {
        const send = await this.channels.prepareSend(id);
        if (!send) break;
        await this.target(await this.channels.internal(id));
        const { adapter } = await this.provider(send.binding);
        await this.channels.assertSend(id, send.event.id, send.event.lease!);
        this.options.worker.signal.throwIfAborted();
        await this.channels.sent(
          id,
          send.event.id,
          send.event.lease!,
          await adapter.send({
            to: send.participant.address,
            text: send.event.reply!,
            ...(send.event.buttons === undefined ? {} : { buttons: send.event.buttons }),
          }),
        );
      }
    } catch {
      this.deps.logger?.warn('assistant.channel.worker', { code: 'channel_work_failed' });
    }
  }
  private async answer(work: ChannelWork): Promise<void> {
    const { binding, participant, event } = work;
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      this.options.worker.signal,
      AbortSignal.timeout(60_000),
    ]);
    const historyRetention = await this.retention(binding);
    const beforeStep = async () => {
      if ((await this.retention(binding)) !== historyRetention)
        throw new ChannelError('history_policy_changed');
      signal.throwIfAborted();
      await this.provider(await this.channels.internal(binding.id));
      await this.channels.renew(binding.id, event.id, event.lease!);
      await this.target(await this.channels.internal(binding.id));
    };
    const timer = setInterval(() => {
      void beforeStep().catch(() => abort.abort());
    }, 10_000);
    timer.unref?.();
    try {
      const target = await this.target(binding);
      const artifact = target.served.artifact;
      const model = await resolveAssistantModelBinding(
        target,
        binding.tenant,
        binding.deploymentId,
        this.deps,
        'whatsapp',
      );
      if (!model) throw new ChannelError('model_not_configured');
      const guarded = withChannelInferenceGuard(
        model,
        this.channels,
        binding.id,
        event.id,
        beforeStep,
      );
      const session: MessagingTurnContext = {
        kind: 'messaging',
        channel: 'whatsapp',
        id: event.id,
        bindingId: binding.id,
        participantId: participant.id,
        tenant: binding.tenant,
        deploymentId: binding.deploymentId,
        caller: { identityKind: 'anonymous', subject: participant.id, roles: [], scopes: [] },
        history: participant.history.map(({ role, content }) => ({ role, content })),
        modelToolUses: participant.modelToolUses ?? [],
      };
      const executeDeps = withAssistantTurnExecutionAuthority(
        { ...target.served.deps, signal },
        artifact,
        session,
      );
      const context = await resolveInvocationContextSnapshot({
        artifact,
        executeDeps,
        caller: session.caller,
        instant: new Date(this.channels.now()),
      });
      const now = this.channels.now();
      const inbound = event.text ?? '';
      // A tapped button is input only for the pending review: it never reaches the model as text,
      // and history keeps the label the participant saw.
      const button = event.button;
      const heard = event.text ?? button?.title ?? '';
      const custody = collectionCustody(this.options.store, binding.id, participant.id);
      let ledger = await custody.load();
      let spec =
        ledger === undefined
          ? undefined
          : collectionSpecFor(artifact, ledger.interactionId, WHATSAPP_CONFIRMATION_EXPIRY_MS);
      if (ledger !== undefined && spec === undefined) {
        // The deployment no longer declares this interaction: the stale ledger is dropped.
        await custody.remove();
        ledger = undefined;
      }
      let outcome: CollectionTurnOutcome =
        button === undefined ? { kind: 'none' } : { kind: 'ignored', code: 'button_unbound' };
      if (ledger !== undefined && spec !== undefined) {
        const toolDeps = { ...executeDeps, caller: session.caller, context };
        outcome = await runCollectionTurn(
          ledger,
          inbound,
          {
            spec,
            artifact,
            now,
            supportEmail: binding.supportEmail,
            buttons: reviewButtonBinding(binding.indexKey, binding.id, participant.id),
            model: {
              binding: guarded,
              fetcher: this.deps.modelFetch ?? ((url, init) => guardedFetch(new URL(url), init)),
              signal,
            },
            prepare: (action, input) =>
              prepareToolForConfirmation(artifact, action, input, toolDeps),
            execute: async (proposalId, continuation) => {
              await beforeStep();
              return executePreparedTool(artifact, continuation, {
                ...toolDeps,
                invocationId: proposalId,
                publicAdmission: {
                  messaging: messagingAdmissionDigest(binding.id, participant.id),
                  provenance: { kind: 'messaging', channel: 'whatsapp' },
                },
              });
            },
            persist: custody.persist,
            remove: custody.remove,
          },
          button?.id,
        );
        ledger = outcome.kind === 'reply' || outcome.kind === 'model' ? outcome.ledger : undefined;
      }
      if (outcome.kind === 'ignored') {
        // An unknown, stale or foreign token: no reply, no model call, one content-free code.
        await this.channels.fail(binding.id, event.id, event.lease!, outcome.code, 'cancelled');
        return;
      }
      let answer: string;
      if (outcome.kind === 'reply') answer = outcome.reply;
      else {
        let text = '',
          failure: string | undefined;
        await runAgentTurn(
          target,
          session,
          outcome.kind === 'model' ? outcome.utterance : inbound,
          context,
          this.deps,
          (result) => {
            if (result.event === 'content' && typeof result.data.delta === 'string')
              text += result.data.delta;
            if (result.event === 'error') failure = String(result.data.code ?? 'answer_failed');
          },
          undefined,
          undefined,
          undefined,
          false,
          {
            binding: guarded,
            beforeStep,
            claimTool: (name) => this.channels.claimTool(binding.id, participant.id, name),
            signal,
            collection: {
              open: ledger,
              now,
              retentionMs: historyRetention,
              confirmationExpiryMs: WHATSAPP_CONFIRMATION_EXPIRY_MS,
              save: async (opened) => {
                await custody.persist(opened);
                ledger = opened;
                spec = collectionSpecFor(
                  artifact,
                  opened.interactionId,
                  WHATSAPP_CONFIRMATION_EXPIRY_MS,
                );
              },
            },
            ...(outcome.kind === 'model' ? { systemNote: outcome.note } : {}),
          },
        );
        if (failure || !text.trim()) throw new ChannelError(failure ?? 'answer_unavailable');
        const disclosure =
          participant.history.length === 0
            ? `I’m ${artifact.server.branding?.name ?? artifact.server.title}’s AI assistant.\n\n`
            : '';
        answer = disclosure + text.trim();
      }
      const bounded =
        answer.length <= 3500
          ? answer
          : `${answer.slice(0, 3350).replace(/[\uD800-\uDBFF]$/u, '')}\n\nAsk me to expand on any part.`;
      // Marked-private values never persist: history and the event row keep redacted text, and the
      // full review outlives only its own delivery.
      const scrub = (text: string) =>
        ledger !== undefined && spec !== undefined ? redactPrivate(spec, ledger, text) : text;
      await this.channels.complete(
        binding.id,
        event.id,
        event.lease!,
        bounded,
        historyRetention,
        undefined,
        { user: scrub(heard), assistant: scrub(bounded) },
        outcome.kind === 'reply' ? outcome.buttons : undefined,
      );
    } catch (error) {
      const code = error instanceof ChannelError ? error.code : 'answer_failed';
      try {
        await this.channels.complete(
          binding.id,
          event.id,
          event.lease!,
          `I couldn’t complete that request. For help, contact ${binding.supportEmail}.`,
          historyRetention,
          code,
        );
      } catch {
        await this.channels.fail(binding.id, event.id, event.lease!, code);
      }
    } finally {
      clearInterval(timer);
    }
  }
}
