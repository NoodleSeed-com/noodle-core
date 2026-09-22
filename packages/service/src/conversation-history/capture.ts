import { createHash, randomUUID } from 'node:crypto';
import type {
  AssistantHistoryMessage,
  AssistantSessionRecord,
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

export interface ConversationOutcome {
  readonly interactionId: string;
  readonly tool: string;
  readonly status: ConversationOutcomeStatus;
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
    return this.#recordSession(session, items);
  }

  recordSessionOutcome(
    session: AssistantSessionRecord,
    outcome: ConversationOutcome,
  ): Promise<void> {
    return this.#recordSession(session, [{ kind: 'outcome', ...outcome, at: this.#now() }]);
  }

  /** Sign-in moves the conversation in progress to the verified customer (ADR 0241 decision 4). */
  reownSession(session: AssistantSessionRecord): Promise<void> {
    const subject = sessionSubject(session);
    if (subject?.kind !== 'customer') return Promise.resolve();
    return this.#guard(session.tenant, async () => {
      await this.store.reown(session.tenant, sessionConversationId(session.id), subject);
    });
  }

  recordChannelTurn(turn: ChannelConversationTurn): Promise<void> {
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
  ): Promise<void> {
    const subject = sessionSubject(session);
    if (!subject || items.length === 0) return Promise.resolve();
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
