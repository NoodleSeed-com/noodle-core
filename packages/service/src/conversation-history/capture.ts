import { createHash, randomUUID } from 'node:crypto';
import {
  type AssistantHistoryMessage,
  type AssistantSessionRecord,
  authenticatedSurfaceOf,
  messagingSurfaceOf,
  publicSurfaceOf,
  surfaceBindingForOrigin,
} from '@noodle-borg/assistant-gateway/portable';
import type { Logger } from '@noodle-borg/transport-http';
import { maskPaymentCards } from '../payment-card.js';
import type { TenantRef } from '../store.js';
import {
  CHANNEL_CONVERSATION_GAP_MS,
  type ConversationHistoryStore,
  type ConversationItem,
  type ConversationOutcomeStatus,
  type ConversationPolicySource,
  type ConversationSource,
  type ConversationSubject,
  effectiveConversationDays,
} from './contracts.js';

/** The session wire contract's bound on a stated window; the stored setting never exceeds it. */
const MAX_NOTICE_DAYS = 365;

export interface ConversationOutcome {
  readonly interactionId: string;
  readonly tool: string;
  readonly status: ConversationOutcomeStatus;
}

/**
 * Whether the surface a caller reached declared `history: false` in server.ts (ADR 0241 decision 11).
 * Call sites resolve it from the artifact they already serve, so capture never re-resolves a target.
 */
export interface SurfaceHistory {
  readonly historyDisabled: boolean;
  /** The authored `historyNotice` template, when the application states its window localized. */
  readonly noticeTemplate?: string;
}

/**
 * The surface a web session is bound to, read from the served assistant. A record minted before
 * `boundSurface` existed derives it as the session target does; an unreadable assistant never records,
 * because nothing proves this caller may be kept.
 */
export function sessionSurfaceHistory(
  assistant: unknown,
  session: Pick<AssistantSessionRecord, 'boundSurface' | 'publicEmbedId' | 'origin'>,
): SurfaceHistory {
  if (assistant === undefined) return { historyDisabled: true };
  const binding =
    session.boundSurface ??
    (session.publicEmbedId !== undefined
      ? 'public'
      : surfaceBindingForOrigin(assistant, session.origin).kind);
  return websiteSurfaceHistory(assistant, binding);
}

/** The website surface a mint binds to; a pre-surfaces or unowned binding declares nothing. */
export function websiteSurfaceHistory(assistant: unknown, binding: string): SurfaceHistory {
  const surface =
    binding === 'public'
      ? publicSurfaceOf(assistant)
      : binding === 'authenticated'
        ? authenticatedSurfaceOf(assistant)
        : undefined;
  return { historyDisabled: surface?.history === false, ...noticeTemplateOf(assistant) };
}

export function messagingSurfaceHistory(assistant: unknown): SurfaceHistory {
  return {
    historyDisabled: messagingSurfaceOf(assistant)?.history === false,
    ...noticeTemplateOf(assistant),
  };
}

/** The compiler admits only a bounded template naming `{days}`; anything else states the default. */
function noticeTemplateOf(assistant: unknown): { readonly noticeTemplate?: string } {
  const template = (assistant as { readonly historyNotice?: unknown } | undefined)?.historyNotice;
  return typeof template === 'string' && template.includes('{days}')
    ? { noticeTemplate: template }
    : {};
}

/** The retention notice in the author's language, else the English default (ADR 0241 decision 17). */
export function historyNoticeText(days: number, template?: string): string {
  return template
    ? template.replaceAll('{days}', String(days))
    : `Chats are kept for ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The same notice as a sentence, for channels without a footer to state it in. */
export function historyNoticeSentence(days: number, template?: string): string {
  const text = historyNoticeText(days, template);
  return /[.!?。！？]$/u.test(text) ? text : `${text}.`;
}

export interface ChannelConversationTurn {
  readonly tenant: TenantRef;
  /** The binding-scoped keyed participant id, never the phone number. */
  readonly participantId: string;
  readonly user: string;
  readonly assistant: string;
  readonly receivedAt: number;
}

/**
 * Records what the customer saw beside each existing working-memory write. Capture is best-effort by
 * contract: a failure is logged as scalars and never fails or delays the customer's turn.
 */
export class ConversationCapture {
  readonly #now: () => number;
  readonly #logger: Logger | undefined;

  constructor(
    private readonly store: ConversationHistoryStore,
    private readonly policy: ConversationPolicySource,
    options: { readonly now?: () => number; readonly logger?: Logger } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
  }

  /** Visible rows only: narration carries tool output and untagged rows fail closed. */
  recordSessionTurn(
    session: AssistantSessionRecord,
    rows: readonly AssistantHistoryMessage[],
    surface: SurfaceHistory,
  ): Promise<void> {
    const at = this.#now();
    const items = rows
      .filter((row) => row.kind === 'visible' && row.content.trim())
      .map(
        (row): ConversationItem => ({
          kind: 'message',
          role: row.role,
          text: maskPaymentCards(row.content),
          at,
        }),
      );
    return this.#recordSession(session, items, surface);
  }

  recordSessionOutcome(
    session: AssistantSessionRecord,
    outcome: ConversationOutcome,
    surface: SurfaceHistory,
  ): Promise<void> {
    return this.#recordSession(
      session,
      [{ kind: 'outcome', ...outcome, at: this.#now() }],
      surface,
    );
  }

  /** Sign-in moves the conversation in progress to the verified customer (ADR 0241 decision 4). */
  reownSession(session: AssistantSessionRecord): Promise<void> {
    const subject = sessionSubject(session);
    if (subject?.kind !== 'customer') return Promise.resolve();
    return this.#guard(session.tenant, async () => {
      await this.store.reown(session.tenant, sessionConversationId(session.id), subject);
    });
  }

  /**
   * The window every channel states to the person it records (ADR 0241 decision 17); 0 means this
   * source or surface is not recorded. Never throws: a notice must not fail a session or a reply.
   */
  async retentionDays(
    tenant: TenantRef,
    source: ConversationSource,
    surface: SurfaceHistory,
  ): Promise<number> {
    if (surface.historyDisabled) return 0;
    try {
      const days = effectiveConversationDays(await this.policy(tenant), source);
      return Number.isInteger(days) && days <= MAX_NOTICE_DAYS ? days : 0;
    } catch {
      this.#logger?.warn('assistant.history.policy_failed', {
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
      });
      return 0;
    }
  }

  recordChannelTurn(turn: ChannelConversationTurn, surface: SurfaceHistory): Promise<void> {
    if (surface.historyDisabled) return Promise.resolve();
    return this.#guard(turn.tenant, async () => {
      const days = effectiveConversationDays(await this.policy(turn.tenant), 'whatsapp');
      if (days === 0) return;
      const now = this.#now();
      const subject = { kind: 'participant', ref: turn.participantId } as const;
      const id =
        (await this.store.findRecent(
          turn.tenant,
          'whatsapp',
          subject,
          turn.receivedAt - CHANNEL_CONVERSATION_GAP_MS,
        )) ?? `cv_${randomUUID()}`;
      await this.store.append(
        { id, tenant: turn.tenant, channel: 'whatsapp', subject },
        [
          { kind: 'message', role: 'user', text: maskPaymentCards(turn.user), at: turn.receivedAt },
          { kind: 'message', role: 'assistant', text: maskPaymentCards(turn.assistant), at: now },
        ].filter((item) => item.text.trim()) as ConversationItem[],
        days,
      );
    });
  }

  #recordSession(
    session: AssistantSessionRecord,
    items: readonly ConversationItem[],
    surface: SurfaceHistory,
  ): Promise<void> {
    const subject = sessionSubject(session);
    if (surface.historyDisabled || !subject || items.length === 0) return Promise.resolve();
    return this.#guard(session.tenant, async () => {
      const source: ConversationSource =
        subject.kind === 'anonymous' ? 'website_visitors' : 'signed_in_customers';
      const days = effectiveConversationDays(await this.policy(session.tenant), source);
      if (days === 0) return;
      await this.store.append(
        {
          id: sessionConversationId(session.id),
          tenant: session.tenant,
          channel: 'website',
          subject,
        },
        items,
        days,
      );
    });
  }

  async #guard(tenant: TenantRef, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.#logger?.warn('assistant.history.capture_failed', {
        org: tenant.org,
        app: tenant.app,
        env: tenant.env,
      });
    }
  }
}

/** Service callers are machine traffic, not a customer conversation. */
function sessionSubject(session: AssistantSessionRecord): ConversationSubject | undefined {
  const { identityKind, subject } = session.caller;
  if (identityKind === 'service' || !subject) return undefined;
  return { kind: identityKind === 'anonymous' ? 'anonymous' : 'customer', ref: subject };
}

/** One conversation per session; the opaque id never exposes the session id itself. */
function sessionConversationId(sessionId: string): string {
  return `cv_${createHash('sha256').update(sessionId).digest('base64url').slice(0, 22)}`;
}

/** The additive session-response notice (ADR 0241 decision 17); empty for an unrecorded caller. */
export async function sessionHistoryNotice(
  conversations: ConversationCapture | undefined,
  tenant: TenantRef,
  source: Exclude<ConversationSource, 'whatsapp'>,
  surface: SurfaceHistory,
): Promise<{ readonly history?: { readonly retentionDays: number; readonly notice?: string } }> {
  const retentionDays = (await conversations?.retentionDays(tenant, source, surface)) ?? 0;
  if (retentionDays <= 0) return {};
  // Only an authored template is sent: absent, every widget already states its English default.
  const notice = surface.noticeTemplate && historyNoticeText(retentionDays, surface.noticeTemplate);
  return { history: { retentionDays, ...(notice ? { notice } : {}) } };
}
