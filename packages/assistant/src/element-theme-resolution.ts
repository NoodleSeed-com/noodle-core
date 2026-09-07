import type { AssistantThemeMode } from './appearance.js';

export type ResolvedAssistantThemeMode = 'light' | 'dark';

/** Resolve the embedding page's theme before falling back to the OS preference. */
export function resolveAssistantTheme(input: {
  readonly host: HTMLElement;
  readonly configured: AssistantThemeMode;
  readonly media?: MediaQueryList;
}): ResolvedAssistantThemeMode {
  if (input.configured === 'light' || input.configured === 'dark') return input.configured;
  const hostMode = resolveHostTheme(input.host, input.media);
  return input.configured === 'invert' ? opposite(hostMode) : hostMode;
}

function resolveHostTheme(
  host: HTMLElement,
  media: MediaQueryList | undefined,
): ResolvedAssistantThemeMode {
  const view = host.ownerDocument.defaultView;
  for (let node = host.parentElement; node; node = node.parentElement) {
    const declared = declaredTheme(node);
    if (declared) return declared;
    const computed = computedTheme(view?.getComputedStyle(node).colorScheme);
    if (computed) return computed;
  }
  return media?.matches ? 'dark' : 'light';
}

function computedTheme(colorScheme: string | undefined): ResolvedAssistantThemeMode | undefined {
  const modes = colorScheme?.split(/\s+/) ?? [];
  if (modes.includes('dark') && !modes.includes('light')) return 'dark';
  if (modes.includes('light') && !modes.includes('dark')) return 'light';
  return undefined;
}

function declaredTheme(element: Element): ResolvedAssistantThemeMode | undefined {
  const value =
    element.getAttribute('data-theme') ??
    element.getAttribute('data-color-scheme') ??
    element.getAttribute('data-mode');
  if (value === 'dark' || value === 'light') return value;
  if (element.classList.contains('dark')) return 'dark';
  if (element.classList.contains('light')) return 'light';
  return undefined;
}

function opposite(mode: ResolvedAssistantThemeMode): ResolvedAssistantThemeMode {
  return mode === 'dark' ? 'light' : 'dark';
}
