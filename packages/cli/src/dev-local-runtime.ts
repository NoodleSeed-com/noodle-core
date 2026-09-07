import { createHash } from 'node:crypto';
import {
  type CounterOutcome,
  type CounterRequest,
  type DailyCounterStore,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits/portable';
import {
  InMemoryAssistantElevationStore,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
  publicSurfaceOf,
} from '@noodle-borg/assistant-gateway/portable';
import { MAX_DOCUMENT_BYTES } from '@noodle-borg/knowledge/limits';
import {
  defaultKnowledgeStores,
  knowledgeTenantKey,
} from '@noodle-borg/knowledge-operations/portable';
import type { RunningService } from '@noodle-borg/service/local';

type LocalTenant = { readonly org: string; readonly app: string; readonly env: string };

/** A truthful durable stand-in for the deliberately single-process local author loop only. */
class ProcessLocalAdmissionCounters implements DailyCounterStore {
  readonly durable = true;
  readonly #inner = new InMemoryDailyCounterStore();

  consume(request: CounterRequest, now: Date): Promise<CounterOutcome> {
    return this.#inner.consume(request, now);
  }

  peek(key: string, now: Date): Promise<number> {
    return this.#inner.peek(key, now);
  }

  prune(now: Date): Promise<number> {
    return this.#inner.prune(now);
  }
}

/** Build the in-memory assistant and knowledge graph owned by `noodle dev`. */
export function createDevLocalRuntime() {
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const knowledge = defaultKnowledgeStores();
  return {
    serviceOptions: {
      assistantStore: new InMemoryAssistantStore(),
      publicEmbeds,
      admissionCounters: new ProcessLocalAdmissionCounters(),
      elevations: new InMemoryAssistantElevationStore(),
      knowledge,
    },
    ensurePublicEmbed: async (registry: RunningService['registry'], tenant: LocalTenant) => {
      const target = await registry.getActiveByTenant(tenant);
      const surface = publicSurfaceOf(target?.served.artifact.server.assistant);
      if (surface === undefined) return undefined;
      const record = await publicEmbeds.ensure({
        ...tenant,
        surfaceMode: surface.mode,
        now: new Date(),
      });
      return record.embedId;
    },
    stageKnowledgeDocument: async ({
      tenant,
      sha256,
      bytes,
    }: {
      readonly tenant: LocalTenant;
      readonly sha256: string;
      readonly bytes: Uint8Array;
    }) => {
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new Error('local knowledge document exceeds the maximum size');
      }
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== sha256) {
        throw new Error('local knowledge document does not match its compiler-pinned hash');
      }
      await knowledge.staging.put(
        knowledgeTenantKey(tenant),
        sha256,
        Buffer.from(bytes),
        bytes.byteLength,
      );
    },
  };
}
