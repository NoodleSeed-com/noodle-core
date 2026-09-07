import { APP_VIEW_TAG_NAME, NoodleAppViewElement } from './app-view-element.js';

export {
  APP_VIEW_TAG_NAME,
  type AssistantAppViewErrorDetail,
  NoodleAppViewElement,
} from './app-view-element.js';
export type { AssistantClient, AssistantViewAvailableDetail } from './client.js';

/** Register the framework-neutral MCP App host. Safe to call more than once or during SSR. */
export function registerNoodleAppView(): void {
  if (!globalThis.customElements?.get(APP_VIEW_TAG_NAME)) {
    globalThis.customElements?.define(APP_VIEW_TAG_NAME, NoodleAppViewElement);
  }
}

registerNoodleAppView();
