'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  type AssistantChatState,
  type AssistantClient,
  type AssistantContext,
  type AssistantModelContextUpdate,
  type AssistantPageContext,
  type CreateAssistantClientOptions,
  createAssistantClient,
} from './client.js';

export type UseNoodleAssistantOptions<
  TPageContext extends AssistantPageContext = AssistantContext,
> = CreateAssistantClientOptions<TPageContext> & {
  /**
   * Browser-local identity for the authenticated principal/tenant.
   * Changing it discards the previous in-memory session and transcript; it is never sent to Noodle.
   */
  readonly principalKey: string;
};

export type UseNoodleAssistantResult<TPageContext extends AssistantPageContext = AssistantContext> =
  AssistantChatState & {
    /** Canonical controller for turns, interactions, context, Apps requests, and aborts. */
    readonly client: AssistantClient<TPageContext>;
  };

interface AssistantReactStore {
  readonly getSnapshot: () => AssistantChatState;
  readonly subscribe: (listener: () => void) => () => void;
}

const useCommittedLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Subscribe a customer-owned React renderer to the DOM-free assistant client.
 *
 * The hook owns only client lifetime and React state projection. Session exchange, transport,
 * retries, interaction continuations, and transcript construction remain client responsibilities.
 */
export function useNoodleAssistant<TPageContext extends AssistantPageContext = AssistantContext>(
  options: UseNoodleAssistantOptions<TPageContext>,
): UseNoodleAssistantResult<TPageContext> {
  const optionsRef = useRef(options);
  const { fetch: injectedFetch, principalKey, sessionEndpoint, embedId, serviceUrl } = options;

  const client = useMemo(() => {
    if (!principalKey.trim()) throw new Error('principalKey is required');
    // The two mounts are spelled out rather than spread from one object: the exclusive union is what
    // stops a caller passing both, and a spread would collapse it back into an ambiguous shape.
    const behavior = {
      ...(injectedFetch ? { fetch: injectedFetch } : {}),
      clientContext: () => readProvider(optionsRef.current.clientContext),
      pageContext: () => readProvider(optionsRef.current.pageContext),
    };
    return embedId !== undefined
      ? createAssistantClient<TPageContext>({
          embedId,
          ...(serviceUrl !== undefined ? { serviceUrl } : {}),
          ...behavior,
        })
      : createAssistantClient<TPageContext>({
          sessionEndpoint: sessionEndpoint ?? '',
          ...behavior,
        });
  }, [injectedFetch, principalKey, sessionEndpoint, embedId, serviceUrl]);
  const store = useMemo(() => createAssistantReactStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const synchronized = useRef<
    | {
        readonly client: AssistantClient<TPageContext>;
        readonly context: AssistantContext | undefined;
        readonly modelContext: AssistantModelContextUpdate | undefined;
      }
    | undefined
  >(undefined);

  useCommittedLayoutEffect(() => {
    optionsRef.current = options;
    const previous = synchronized.current;
    if (previous?.client === client) {
      if (previous.context !== options.context) {
        client.updateContext(options.context ?? {});
      }
      if (previous.modelContext !== options.modelContext) {
        client.updateModelContext(options.modelContext ?? {});
      }
    } else {
      if (options.context !== undefined) client.updateContext(options.context);
      if (options.modelContext !== undefined) client.updateModelContext(options.modelContext);
    }
    synchronized.current = {
      client,
      context: options.context,
      modelContext: options.modelContext,
    };
  }, [client, options]);

  useCommittedLayoutEffect(
    () => () => {
      client.abort();
      client.resetSession();
    },
    [client],
  );

  return useMemo(() => ({ client, ...state }), [client, state]);
}

function createAssistantReactStore<TPageContext extends AssistantPageContext>(
  client: AssistantClient<TPageContext>,
): AssistantReactStore {
  let snapshot = client.getChatState();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      let subscribing = true;
      const unsubscribe = client.subscribeChat((next) => {
        snapshot = next;
        if (!subscribing) listener();
      });
      subscribing = false;
      return unsubscribe;
    },
  };
}

function readProvider<T>(value: T | (() => T | undefined) | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T | undefined)() : value;
}
