import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AppFlow, type AppFlowConfig, useAppFlow } from './app-flow.js';
import {
  bridge,
  type DisplayMode,
  globalBranding,
  globalLayout,
  globalToolResult,
  globalViewState,
  type LayoutState,
  type ModelContextUpdate,
  type NoodleReactBridge,
  type RuntimeBranding,
  requireBridge,
  setGlobalViewState,
  type ToolResult,
  useBridgeVersion,
} from './bridge.js';
import { type HandoffController, useHandoff } from './handoff.js';
import { copyBoundedModelContext } from './model-context-validation.js';
import { createViewStore } from './store.js';

export type ToolStatus = 'idle' | 'pending' | 'success' | 'error';

export type CallToolState = {
  readonly status: ToolStatus;
  readonly data?: ToolResult;
  readonly error?: Error;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly meta?: unknown;
  readonly toolError?: boolean;
  readonly isIdle: boolean;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly callTool: (input?: unknown) => Promise<ToolResult>;
  readonly callToolAsync: (input?: unknown) => Promise<ToolResult>;
  readonly reset: () => void;
};

export type GeneratedReactHelpers = {
  readonly useWidgetReady: () => boolean;
  readonly useToolInfo: (toolName?: string) => ToolResult;
  readonly useCallTool: (toolName: string) => CallToolState;
  readonly useViewState: <T>(
    key: string,
    initialValue: T,
  ) => readonly [T, (value: T | ((current: T) => T)) => void];
  readonly useLayout: () => LayoutState;
  readonly useBranding: () => RuntimeBranding;
  readonly useRequestDisplayMode: () => (mode: LayoutState['displayMode']) => Promise<void>;
  readonly useOpenExternal: () => (url: string) => Promise<void>;
  readonly useSendFollowUpMessage: () => (message: { readonly prompt: string }) => Promise<void>;
  readonly useUpdateModelContext: () => (update: ModelContextUpdate) => Promise<void>;
  readonly useWidgetLifecycle: (
    widgetName: string,
  ) => (
    lifecycle: 'mounted' | 'submitted' | 'cancelled' | 'dismissed',
    summary?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly useAppFlow: <ViewName extends string>(
    config: AppFlowConfig<ViewName>,
  ) => AppFlow<ViewName>;
  readonly useHandoff: () => HandoffController;
  readonly createViewStore: typeof createViewStore;
};

export function generateHelpers<_AppType>(): GeneratedReactHelpers {
  return {
    useWidgetReady,
    useToolInfo,
    useCallTool,
    useViewState,
    useLayout,
    useBranding,
    useRequestDisplayMode,
    useOpenExternal,
    useSendFollowUpMessage,
    useUpdateModelContext,
    useWidgetLifecycle,
    useAppFlow,
    useHandoff,
    createViewStore,
  };
}

/** True only after the host-neutral MCP Apps bridge has completed its connection handshake. */
export function useWidgetReady(): boolean {
  useBridgeVersion();
  return bridge() !== undefined;
}

export function useToolInfo(toolName?: string): ToolResult {
  useBridgeVersion();
  return bridge()?.getToolResult?.(toolName) ?? globalToolResult();
}

export function useBranding(): RuntimeBranding {
  useBridgeVersion();
  return bridge()?.getBranding?.() ?? globalBranding();
}

export function useCallTool(toolName: string): CallToolState {
  useBridgeVersion();
  const [data, setData] = useState<ToolResult | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [status, setStatus] = useState<ToolStatus>('idle');
  const callToolAsync = useCallback(
    async (input?: unknown) => {
      setStatus('pending');
      setData(undefined);
      setError(undefined);
      try {
        const currentBridge = requireBridge();
        if (currentBridge.callServerTool === undefined) {
          throw new Error('Noodle widget bridge does not support tool calls');
        }
        const result = await currentBridge.callServerTool({ name: toolName, arguments: input });
        const normalized = result ?? {};
        setData(normalized);
        setStatus('success');
        return normalized;
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        setError(err);
        setStatus('error');
        throw err;
      }
    },
    [toolName],
  );
  const reset = useCallback(() => {
    setData(undefined);
    setError(undefined);
    setStatus('idle');
  }, []);
  return {
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
    ...(data?.content === undefined ? {} : { content: data.content }),
    ...(data?.structuredContent === undefined ? {} : { structuredContent: data.structuredContent }),
    ...(data?._meta === undefined ? {} : { meta: data._meta }),
    ...(data?.isError === undefined ? {} : { toolError: data.isError }),
    status,
    isIdle: status === 'idle',
    isPending: status === 'pending',
    isSuccess: status === 'success',
    isError: status === 'error',
    callTool: callToolAsync,
    callToolAsync,
    reset,
  };
}

export function useViewState<T>(
  key: string,
  initialValue: T,
): readonly [T, (value: T | ((current: T) => T)) => void] {
  useBridgeVersion();
  const value = readViewState(key, initialValue);
  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const current = bridge()?.getViewState?.() ?? globalViewState();
      const currentValue = (current[key] === undefined ? initialValue : current[key]) as T;
      const resolved =
        typeof next === 'function' ? (next as (current: T) => T)(currentValue) : next;
      const patch = { ...current, [key]: resolved };
      bridge()?.setWidgetState?.(patch);
      if (bridge()?.setWidgetState === undefined) setGlobalViewState(patch);
    },
    [initialValue, key],
  );
  return useMemo(() => [value, setValue] as const, [value, setValue]);
}

export function useLayout(): LayoutState {
  useBridgeVersion();
  return bridge()?.getLayout?.() ?? globalLayout();
}

export function useRequestDisplayMode(): (mode: LayoutState['displayMode']) => Promise<void> {
  useBridgeVersion();
  return useCallback(async (mode: LayoutState['displayMode']) => {
    const currentBridge = requireBridge();
    if (currentBridge.requestDisplayMode === undefined) {
      throw new Error('Noodle widget bridge does not support display mode requests');
    }
    await currentBridge.requestDisplayMode(mode);
  }, []);
}

export function useOpenExternal(): (url: string) => Promise<void> {
  useBridgeVersion();
  return useCallback(async (url: string) => {
    const currentBridge = requireBridge();
    if (currentBridge.openExternal === undefined) {
      throw new Error('Noodle widget bridge does not support external links');
    }
    await currentBridge.openExternal(url);
  }, []);
}

export function useSendFollowUpMessage(): (message: { readonly prompt: string }) => Promise<void> {
  useBridgeVersion();
  return useCallback(async (message: { readonly prompt: string }) => {
    const currentBridge = requireBridge();
    if (currentBridge.sendFollowUpMessage === undefined) {
      throw new Error('Noodle widget bridge does not support follow-up messages');
    }
    await currentBridge.sendFollowUpMessage(message);
  }, []);
}

/** Publish only the compact widget summary an author deliberately chooses to expose to the model. */
export function useUpdateModelContext(): (update: ModelContextUpdate) => Promise<void> {
  useBridgeVersion();
  return useCallback(async (update: ModelContextUpdate) => {
    const copy = copyBoundedModelContext(update);
    const currentBridge = requireBridge();
    if (currentBridge.updateModelContext === undefined) {
      throw new Error('Noodle widget bridge does not support model context updates');
    }
    await currentBridge.updateModelContext(copy);
  }, []);
}

/** Publish a portable, structured widget lifecycle summary through the standard model-context path. */
export function useWidgetLifecycle(
  widgetName: string,
): (
  lifecycle: 'mounted' | 'submitted' | 'cancelled' | 'dismissed',
  summary?: Readonly<Record<string, unknown>>,
) => Promise<void> {
  const ready = useWidgetReady();
  const updateModelContext = useUpdateModelContext();
  const publish = useCallback(
    async (
      lifecycle: 'mounted' | 'submitted' | 'cancelled' | 'dismissed',
      summary: Readonly<Record<string, unknown>> = {},
    ) => {
      await updateModelContext({
        content: [{ type: 'text', text: `Widget ${widgetName} was ${lifecycle}.` }],
        structuredContent: {
          widget: { ...summary, name: widgetName, lifecycle },
        },
      });
    },
    [updateModelContext, widgetName],
  );
  useEffect(() => {
    if (!ready) return;
    if (bridge()?.updateModelContext === undefined) return;
    const events = globalThis as typeof globalThis & {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    const publishBestEffort = (lifecycle: 'mounted' | 'cancelled' | 'dismissed'): void => {
      void publish(lifecycle).catch(() => undefined);
    };
    const cancelled = (): void => publishBestEffort('cancelled');
    const dismissed = (): void => publishBestEffort('dismissed');
    events.addEventListener?.('noodle:toolcancelled', cancelled);
    events.addEventListener?.('noodle:teardown', dismissed);
    publishBestEffort('mounted');
    return () => {
      events.removeEventListener?.('noodle:toolcancelled', cancelled);
      events.removeEventListener?.('noodle:teardown', dismissed);
    };
  }, [publish, ready]);
  return publish;
}

function readViewState<T>(key: string, initialValue: T): T {
  const value = bridge()?.getViewState?.()?.[key] ?? globalViewState()[key];
  return value === undefined ? initialValue : (value as T);
}

export type {
  DisplayMode,
  LayoutState,
  ModelContextUpdate,
  NoodleReactBridge,
  RuntimeBranding,
  ToolResult,
};
