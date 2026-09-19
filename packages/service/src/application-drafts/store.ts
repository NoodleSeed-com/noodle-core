import { createHash, randomUUID } from 'node:crypto';
import { validateSlug } from '@noodle-borg/control-plane/portable';
import {
  APPLICATION_DRAFT_LIMITS,
  type ApplicationDraft,
  ApplicationDraftCreateRequestSchema,
  type ApplicationDraftDiff,
  ApplicationDraftDiffRequestSchema,
  ApplicationDraftEditRequestSchema,
  ApplicationDraftIdSchema,
  type ApplicationDraftSource,
  type ApplicationDraftSummary,
  ApplicationDraftUndoRequestSchema,
} from '@noodle-borg/wire-contracts';
import {
  type ApplicationDraftBackend,
  ApplicationDraftError,
  type ApplicationDraftScope,
  type ApplicationDraftTransaction,
} from './contracts.js';

interface Command {
  readonly scope: ApplicationDraftScope;
  readonly actorSubject: string;
  readonly idempotencyKey: string;
}
interface Change extends Command {
  readonly id: string;
  readonly expectedRevision: number;
}

export interface ApplicationDraftStoreOptions {
  /** Called inside the workspace transaction. Hosted authorization joins that same transaction/lock. */
  readonly authorize: (
    scope: ApplicationDraftScope,
    actor: string,
    permission: 'drafts:read' | 'drafts:edit',
  ) => Promise<boolean>;
}

export class ApplicationDraftStore {
  constructor(
    private readonly backend: ApplicationDraftBackend,
    private readonly options: ApplicationDraftStoreOptions,
  ) {}

  create(
    input: Command & {
      readonly environment: string;
      readonly source: ApplicationDraftSource;
      readonly baseRelease?: string;
    },
  ): Promise<ApplicationDraft> {
    const parsed = ApplicationDraftCreateRequestSchema.safeParse({
      environment: input.environment,
      source: input.source,
      ...(input.baseRelease === undefined ? {} : { baseRelease: input.baseRelease }),
    });
    if (!parsed.success) return Promise.reject(new ApplicationDraftError('invalid_draft'));
    try {
      validateSlug('env', parsed.data.environment);
    } catch {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    return this.mutate(input, ['create', parsed.data], async (tx) => {
      if ((await tx.heads()).length >= APPLICATION_DRAFT_LIMITS.draftsPerApp)
        throw new ApplicationDraftError('draft_limit');
      return {
        ...input.scope,
        ...parsed.data,
        id: randomUUID(),
        revision: 1,
        sourceDigest: applicationDraftSourceDigest(parsed.data.source),
        createdAt: tx.now,
        updatedAt: tx.now,
        createdBySubject: input.actorSubject,
        updatedBySubject: input.actorSubject,
        origin: 'manual',
      };
    });
  }

  edit(input: Change & { readonly source: ApplicationDraftSource }): Promise<ApplicationDraft> {
    const parsed = ApplicationDraftEditRequestSchema.safeParse({
      expectedRevision: input.expectedRevision,
      source: input.source,
    });
    if (!parsed.success) return Promise.reject(new ApplicationDraftError('invalid_draft'));
    return this.mutate(input, ['edit', input.id, parsed.data], async (tx) => {
      const current = await this.current(tx, input);
      return {
        ...current,
        revision: current.revision + 1,
        source: parsed.data.source,
        sourceDigest: applicationDraftSourceDigest(parsed.data.source),
        updatedAt: tx.now,
        updatedBySubject: input.actorSubject,
        origin: 'manual',
      };
    });
  }

  undo(input: Change & { readonly targetRevision: number }): Promise<ApplicationDraft> {
    const parsed = ApplicationDraftUndoRequestSchema.safeParse({
      expectedRevision: input.expectedRevision,
      targetRevision: input.targetRevision,
    });
    if (!parsed.success) return Promise.reject(new ApplicationDraftError('invalid_draft'));
    return this.mutate(input, ['undo', input.id, parsed.data], async (tx) => {
      const current = await this.current(tx, input);
      const target = await tx.get(input.id, parsed.data.targetRevision);
      if (!target) throw new ApplicationDraftError('not_found');
      return {
        ...current,
        revision: current.revision + 1,
        source: target.source,
        sourceDigest: target.sourceDigest,
        updatedAt: tx.now,
        updatedBySubject: input.actorSubject,
        origin: 'undo',
      };
    });
  }

  get(
    scope: ApplicationDraftScope,
    id: string,
    actor: string,
    revision?: number,
  ): Promise<ApplicationDraft> {
    if (
      !ApplicationDraftIdSchema.safeParse(id).success ||
      (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
    ) {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    return this.authorized(scope, actor, 'drafts:read', async (tx) => {
      const draft = await tx.get(id, revision);
      if (!draft) throw new ApplicationDraftError('not_found');
      return draft;
    });
  }

  list(scope: ApplicationDraftScope, actor: string): Promise<readonly ApplicationDraftSummary[]> {
    return this.authorized(scope, actor, 'drafts:read', (tx) => tx.heads());
  }

  history(
    scope: ApplicationDraftScope,
    id: string,
    actor: string,
  ): Promise<readonly ApplicationDraftSummary[]> {
    if (!ApplicationDraftIdSchema.safeParse(id).success)
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    return this.authorized(scope, actor, 'drafts:read', async (tx) => {
      const revisions = await tx.history(id);
      if (!revisions.length) throw new ApplicationDraftError('not_found');
      return revisions;
    });
  }

  diff(
    scope: ApplicationDraftScope,
    id: string,
    actor: string,
    from: number,
    to: number,
  ): Promise<ApplicationDraftDiff> {
    if (
      !ApplicationDraftIdSchema.safeParse(id).success ||
      !ApplicationDraftDiffRequestSchema.safeParse({ from, to }).success
    )
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    return this.authorized(scope, actor, 'drafts:read', async (tx) => {
      const before = await tx.get(id, from),
        after = await tx.get(id, to);
      if (!before || !after) throw new ApplicationDraftError('not_found');
      const oldFiles = new Map(before.source.files.map((file) => [file.path, file.content]));
      const newFiles = new Map(after.source.files.map((file) => [file.path, file.content]));
      return {
        draftId: id,
        fromRevision: from,
        toRevision: to,
        fromDigest: before.sourceDigest,
        toDigest: after.sourceDigest,
        fromEntrypoint: before.source.entrypoint,
        toEntrypoint: after.source.entrypoint,
        changes: [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
          .sort()
          .flatMap((path) =>
            oldFiles.get(path) === newFiles.get(path)
              ? []
              : [{ path, before: oldFiles.get(path) ?? null, after: newFiles.get(path) ?? null }],
          ),
      };
    });
  }

  /** Explicit draft erasure never touches the separately published immutable application. */
  remove(input: Omit<Change, 'idempotencyKey'>): Promise<void> {
    if (
      !ApplicationDraftIdSchema.safeParse(input.id).success ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    return this.authorized(input.scope, input.actorSubject, 'drafts:edit', async (tx) => {
      const draft = await tx.get(input.id);
      if (!draft) return;
      if (draft.revision !== input.expectedRevision)
        throw new ApplicationDraftError('revision_conflict', draft.revision);
      await tx.remove(input.id);
    });
  }

  private async current(tx: ApplicationDraftTransaction, input: Change): Promise<ApplicationDraft> {
    if (!ApplicationDraftIdSchema.safeParse(input.id).success)
      throw new ApplicationDraftError('invalid_draft');
    const current = await tx.get(input.id);
    if (!current) throw new ApplicationDraftError('not_found');
    if (current.revision !== input.expectedRevision) {
      throw new ApplicationDraftError('revision_conflict', current.revision);
    }
    if (current.revision >= APPLICATION_DRAFT_LIMITS.revisionsPerDraft)
      throw new ApplicationDraftError('revision_limit', current.revision);
    return current;
  }

  private mutate(
    input: Command,
    body: unknown,
    change: (tx: ApplicationDraftTransaction) => Promise<ApplicationDraft>,
  ): Promise<ApplicationDraft> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    return this.authorized(input.scope, input.actorSubject, 'drafts:edit', async (tx) => {
      const key = hash([input.actorSubject, input.idempotencyKey]);
      const fingerprint = hash(body);
      const receipt = await tx.receipt(key);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new ApplicationDraftError('idempotency_conflict');
        const draft = await tx.get(receipt.draftId, receipt.revision);
        if (!draft) throw new ApplicationDraftError('draft_deleted');
        return draft;
      }
      const draft = await change(tx);
      const capacity = await tx.capacity();
      if (draft.revision === 1 && capacity.drafts >= APPLICATION_DRAFT_LIMITS.draftsPerWorkspace)
        throw new ApplicationDraftError('draft_limit');
      if (
        capacity.sourceBytes + applicationDraftSourceBytes(draft.source) >
        APPLICATION_DRAFT_LIMITS.sourceBytesPerWorkspace
      )
        throw new ApplicationDraftError('source_capacity');
      if (capacity.receipts >= APPLICATION_DRAFT_LIMITS.receiptsPerWorkspace)
        throw new ApplicationDraftError('retry_capacity');
      await tx.append(draft);
      await tx.saveReceipt(key, {
        fingerprint,
        draftId: draft.id,
        revision: draft.revision,
        expiresAt: new Date(
          Date.parse(tx.now) + APPLICATION_DRAFT_LIMITS.retryWindowMs,
        ).toISOString(),
      });
      return draft;
    });
  }

  private authorized<T>(
    scope: ApplicationDraftScope,
    actor: string,
    permission: 'drafts:read' | 'drafts:edit',
    work: (tx: ApplicationDraftTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      validateSlug('org', scope.org);
      validateSlug('app', scope.app);
    } catch {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    if (actor.length < 1 || actor.length > 500) {
      return Promise.reject(new ApplicationDraftError('invalid_draft'));
    }
    return this.backend.run(scope, async (tx) => {
      if (!(await this.options.authorize(scope, actor, permission)))
        throw new ApplicationDraftError('forbidden');
      return work(tx);
    });
  }
}

export function applicationDraftSourceDigest(source: ApplicationDraftSource): string {
  return hash({
    entrypoint: source.entrypoint,
    files: [...source.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

export function applicationDraftSourceBytes(source: ApplicationDraftSource): number {
  return source.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
