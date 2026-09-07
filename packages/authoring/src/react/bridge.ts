import { useSyncExternalStore } from 'react';

export type ToolResult = {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly _meta?: unknown;
  readonly isError?: boolean;
};

export type DisplayMode = 'inline' | 'pip' | 'fullscreen';

export type LayoutState = {
  readonly theme: 'light' | 'dark';
  readonly displayMode: DisplayMode;
  readonly availableDisplayModes?: readonly DisplayMode[];
  readonly containerDimensions?: {
    readonly width?: number;
    readonly height?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  };
  readonly locale?: string;
  readonly timeZone?: string;
  readonly host?: string;
  readonly platform?: 'web' | 'desktop' | 'mobile';
  readonly deviceCapabilities?: {
    readonly touch?: boolean;
    readonly hover?: boolean;
  };
  readonly safeAreaInsets?: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly supports?: {
    readonly fullscreen?: boolean;
    readonly pip?: boolean;
    readonly openExternal?: boolean;
    readonly followUpMessage?: boolean;
    readonly modelContext?: boolean;
  };
};

export type ModelContextUpdate = {
  readonly content?: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
};

type RuntimeBrandAsset = {
  readonly uri: string;
  readonly darkUri?: string;
  readonly alt: string;
};

type RuntimeBrandTheme = {
  readonly surface?: string;
  readonly surfaceRaised?: string;
  readonly surfaceMuted?: string;
  readonly text?: string;
  readonly textMuted?: string;
  readonly accent?: string;
  readonly accentText?: string;
  readonly link?: string;
  readonly border?: string;
  readonly borderStrong?: string;
  readonly focus?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
  readonly code?: string;
};

export type RuntimeBranding = {
  readonly name?: string;
  readonly accent?: string;
  readonly surface?: string;
  readonly surfaceDark?: string;
  readonly logo?: RuntimeBrandAsset;
  readonly mark?: RuntimeBrandAsset;
  readonly avatar?: RuntimeBrandAsset;
  readonly theme?: {
    readonly light?: RuntimeBrandTheme;
    readonly dark?: RuntimeBrandTheme;
  };
  readonly radius?: 'none' | 'sm' | 'md' | 'lg';
  readonly density?: 'compact' | 'comfortable';
  readonly typography?: 'system' | 'serif' | 'mono';
  readonly colorScheme?: 'auto' | 'light' | 'dark';
};

export interface NoodleReactBridge {
  readonly getToolResult?: (toolName?: string) => ToolResult | undefined;
  readonly getViewState?: () => Record<string, unknown>;
  readonly setWidgetState?: (patch: Record<string, unknown>) => void;
  readonly getLayout?: () => LayoutState;
  readonly getBranding?: () => RuntimeBranding;
  readonly callServerTool?: (request: {
    readonly name: string;
    readonly arguments?: unknown;
  }) => Promise<ToolResult>;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly sendFollowUpMessage?: (message: { readonly prompt: string }) => Promise<void>;
  readonly updateModelContext?: (update: ModelContextUpdate) => Promise<void>;
  readonly requestDisplayMode?: (mode: LayoutState['displayMode']) => Promise<void>;
}

const EVENTS = [
  'noodle:data',
  'noodle:state',
  'noodle:input',
  'noodle:layout',
  'noodle:bridge',
] as const;

type EventfulGlobal = typeof globalThis & {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  dispatchEvent?: (event: unknown) => boolean;
  CustomEvent?: new (type: string) => unknown;
};

export function useBridgeVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}

export function bridge(): NoodleReactBridge | undefined {
  return (globalThis as { __noodleReactBridge?: NoodleReactBridge }).__noodleReactBridge;
}

export function requireBridge(): NoodleReactBridge {
  const current = bridge();
  if (current === undefined) throw new Error('Noodle widget bridge is not connected yet');
  return current;
}

export function globalToolResult(): ToolResult {
  return (globalThis as { __noodleToolResult?: ToolResult }).__noodleToolResult ?? {};
}

export function globalViewState(): Record<string, unknown> {
  const value = (globalThis as { __noodleState?: unknown }).__noodleState;
  return value !== null && typeof value === 'object'
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function setGlobalViewState(value: Record<string, unknown>): void {
  (globalThis as { __noodleState?: Record<string, unknown> }).__noodleState = value;
  bumpBridgeVersion('noodle:state');
}

export function globalLayout(): LayoutState {
  const value = (globalThis as { __noodleLayout?: Partial<LayoutState> }).__noodleLayout ?? {};
  const displayMode =
    value.displayMode === 'fullscreen' || value.displayMode === 'pip'
      ? value.displayMode
      : 'inline';
  const availableDisplayModes = value.availableDisplayModes?.filter(isDisplayMode);
  return {
    theme: value.theme === 'dark' ? 'dark' : 'light',
    displayMode,
    ...(availableDisplayModes === undefined ? {} : { availableDisplayModes }),
    ...(value.containerDimensions === undefined
      ? {}
      : { containerDimensions: { ...value.containerDimensions } }),
    ...(value.locale !== undefined ? { locale: value.locale } : {}),
    ...(value.timeZone !== undefined ? { timeZone: value.timeZone } : {}),
    ...(value.host !== undefined ? { host: value.host } : {}),
    ...(value.platform !== undefined ? { platform: value.platform } : {}),
    ...(value.deviceCapabilities === undefined
      ? {}
      : { deviceCapabilities: { ...value.deviceCapabilities } }),
    ...(value.safeAreaInsets === undefined ? {} : { safeAreaInsets: { ...value.safeAreaInsets } }),
    ...(value.supports !== undefined ? { supports: { ...value.supports } } : {}),
  };
}

export function globalBranding(): RuntimeBranding {
  const value = (globalThis as { __noodleBranding?: RuntimeBranding }).__noodleBranding;
  return value ? { ...value } : {};
}

function isDisplayMode(value: string): value is DisplayMode {
  return value === 'inline' || value === 'pip' || value === 'fullscreen';
}

function subscribe(onChange: () => void): () => void {
  const target = eventfulGlobal();
  if (typeof target.addEventListener !== 'function') return () => undefined;
  for (const event of EVENTS) target.addEventListener(event, onChange);
  return () => {
    if (typeof target.removeEventListener !== 'function') return;
    for (const event of EVENTS) target.removeEventListener(event, onChange);
  };
}

function snapshot(): number {
  return Number((globalThis as { __noodleReactVersion?: number }).__noodleReactVersion ?? 0);
}

function bumpBridgeVersion(eventName: (typeof EVENTS)[number]): void {
  const target = globalThis as { __noodleReactVersion?: number };
  target.__noodleReactVersion = (target.__noodleReactVersion ?? 0) + 1;
  const events = eventfulGlobal();
  try {
    if (typeof events.dispatchEvent === 'function' && events.CustomEvent) {
      events.dispatchEvent(new events.CustomEvent(eventName));
    }
  } catch {
    // Non-browser test runtimes may not provide CustomEvent.
  }
}

function eventfulGlobal(): EventfulGlobal {
  return globalThis as EventfulGlobal;
}
