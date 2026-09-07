import {
  createElement,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type { AssistantThemeMode } from './appearance.js';
import type { AssistantAppearance, AssistantAppearanceWarning } from './host-appearance.js';

export type { AssistantAppearance, AssistantAppearanceWarning } from './host-appearance.js';

import type {
  AssistantClientEvent,
  AssistantContext,
  AssistantModelContextUpdate,
  AssistantPageContext,
} from './client.js';
import { type NoodleAssistantElement, registerNoodleAssistant } from './element.js';
import type { AssistantErrorDetail } from './transport.js';

export { NoodleAppView, type NoodleAppViewProps } from './react-app-view.js';

export interface NoodleAssistantProps<
  TPageContext extends AssistantPageContext = AssistantContext,
> {
  /** In-app mount: the customer backend route that exchanges an embed secret for a session. */
  readonly sessionEndpoint?: string;
  /** Public mount: the non-secret embed id `noodle deploy` printed. Exclusive with `sessionEndpoint`. */
  readonly embedId?: string;
  /** Only for a dev or self-hosted service; a published page needs no origin. */
  readonly serviceUrl?: string;
  readonly theme?: AssistantThemeMode;
  readonly appearance?: AssistantAppearance;
  readonly open?: boolean;
  readonly className?: string;
  readonly context?: AssistantContext;
  readonly pageContext?: TPageContext;
  readonly modelContext?: AssistantModelContextUpdate;
  readonly onEvent?: (event: AssistantClientEvent) => void;
  /**
   * Fires at most once per component instance, when the element's shadow DOM is rendered and its
   * imperative API (`sendMessage`, `confirmTool`, …) is callable — NOT when a session exists (listen
   * for the `session_started` client event via `onEvent` for that). It fires whether the element
   * upgraded before or after this component mounted, and the first callback identity wins: a later
   * re-render with a different `onReady` is never invoked.
   */
  readonly onReady?: () => void;
  readonly onError?: (error: AssistantErrorDetail) => void;
  readonly onAppearanceWarning?: (warning: AssistantAppearanceWarning) => void;
  readonly onSessionExpired?: () => void;
}

const NoodleAssistantWithRef = forwardRef<NoodleAssistantElement, NoodleAssistantProps>(
  function NoodleAssistant(props, forwardedRef): ReactElement {
    const ref = useRef<NoodleAssistantElement>(null);
    const readyNotified = useRef(false);
    useImperativeHandle(forwardedRef, () => ref.current as NoodleAssistantElement, []);
    useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const ready = () => {
        if (readyNotified.current) return;
        readyNotified.current = true;
        // The one observable breadcrumb for the readiness path: integrators could previously
        // neither convict nor exonerate this callback for a field failure.
        console.debug('[noodle-assistant] ready');
        props.onReady?.();
      };
      const error = (event: Event) =>
        props.onError?.((event as CustomEvent<AssistantErrorDetail>).detail);
      const expired = () => props.onSessionExpired?.();
      const assistantEvent = (event: Event) =>
        props.onEvent?.((event as CustomEvent<AssistantClientEvent>).detail);
      const appearanceWarning = (event: Event) =>
        props.onAppearanceWarning?.((event as CustomEvent<AssistantAppearanceWarning>).detail);
      element.addEventListener('assistant-ready', ready);
      element.addEventListener('assistant-error', error);
      element.addEventListener('assistant-session-expired', expired);
      element.addEventListener('assistant-event', assistantEvent);
      element.addEventListener('assistant-appearance-warning', appearanceWarning);
      registerNoodleAssistant();
      element.sessionEndpoint = props.sessionEndpoint ?? '';
      element.embedId = props.embedId ?? '';
      element.serviceUrl = props.serviceUrl ?? '';
      element.appearance = props.appearance;
      element.toggleAttribute('open', props.open === true);
      if (props.context) element.updateContext(props.context);
      if (props.pageContext) element.updatePageContext(props.pageContext);
      if (props.modelContext) element.updateModelContext(props.modelContext);
      // The canonical entry may have registered and upgraded the element before this effect ran.
      // Readiness is sticky once the shadow root exists, so late React listeners still fire once.
      if (element.shadowRoot) ready();
      return () => {
        element.removeEventListener('assistant-ready', ready);
        element.removeEventListener('assistant-error', error);
        element.removeEventListener('assistant-session-expired', expired);
        element.removeEventListener('assistant-event', assistantEvent);
        element.removeEventListener('assistant-appearance-warning', appearanceWarning);
      };
    }, [
      props.context,
      props.appearance,
      props.modelContext,
      props.onError,
      props.onAppearanceWarning,
      props.onEvent,
      props.onReady,
      props.onSessionExpired,
      props.open,
      props.pageContext,
      props.sessionEndpoint,
      props.embedId,
      props.serviceUrl,
    ]);
    return createElement('noodle-assistant', {
      ref,
      class: props.className,
      ...(props.sessionEndpoint ? { 'session-endpoint': props.sessionEndpoint } : {}),
      ...(props.embedId ? { 'embed-id': props.embedId } : {}),
      ...(props.serviceUrl ? { 'service-url': props.serviceUrl } : {}),
      ...(props.theme ? { theme: props.theme } : {}),
    });
  },
);

export const NoodleAssistant = NoodleAssistantWithRef as <
  TPageContext extends AssistantPageContext = AssistantContext,
>(
  props: NoodleAssistantProps<TPageContext> & RefAttributes<NoodleAssistantElement>,
) => ReactElement;
