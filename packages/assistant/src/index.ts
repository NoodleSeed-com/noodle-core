export {
  ASSISTANT_TAG_NAME,
  NoodleAssistantElement,
  registerNoodleAssistant,
} from './element.js';
export type { AssistantViewAvailableDetail, AssistantViewAvailableEvent } from './events.js';
export type {
  AssistantAppearance,
  AssistantAppearanceTheme,
  AssistantAppearanceWarning,
  AssistantSurfaceAppearance,
} from './host-appearance.js';
export type { AssistantErrorDetail, AssistantEvent } from './transport.js';

import { registerNoodleAssistant } from './element.js';

registerNoodleAssistant();
