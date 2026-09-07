import { createElement, type ReactElement, useEffect, useRef } from 'react';
import {
  APP_VIEW_TAG_NAME,
  type AssistantAppViewErrorDetail,
  type NoodleAppViewElement,
  registerNoodleAppView,
} from './app-view.js';
import type { AssistantClient, AssistantViewAvailableDetail } from './client.js';

export interface NoodleAppViewProps {
  readonly client: AssistantClient;
  readonly view: AssistantViewAvailableDetail;
  readonly theme?: 'light' | 'dark';
  /** Permit App-requested fullscreen presentation. Defaults to inline-only. */
  readonly allowFullscreen?: boolean;
  readonly className?: string;
  readonly onError?: (failure: AssistantAppViewErrorDetail) => void;
}

/**
 * Securely hosts one service-resolved MCP App inside a customer-owned React renderer.
 *
 * Compatibility adapter for the framework-neutral `<noodle-app-view>` host.
 */
export function NoodleAppView({
  client,
  view,
  theme = 'light',
  allowFullscreen = false,
  className,
  onError,
}: NoodleAppViewProps): ReactElement {
  const elementRef = useRef<NoodleAppViewElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const handleError = (event: Event) => {
      onErrorRef.current?.((event as CustomEvent<AssistantAppViewErrorDetail>).detail);
    };
    element.addEventListener('assistant-error', handleError);
    registerNoodleAppView();
    return () => {
      element.removeEventListener('assistant-error', handleError);
    };
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (element.client !== client) element.view = undefined;
    element.allowFullscreen = allowFullscreen;
    element.client = client;
    element.theme = theme;
    element.view = view;
  }, [allowFullscreen, client, theme, view]);

  return createElement(APP_VIEW_TAG_NAME, { ref: elementRef, class: className });
}
