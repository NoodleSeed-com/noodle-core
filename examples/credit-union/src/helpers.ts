import type { ServerDefinition } from '@noodleseed/one';

export {
  Action,
  Collection,
  Fact,
  Flow,
  Frame,
  Region,
  ShellNav,
  StatusBadge,
  View,
  ViewStack,
} from '@noodleseed/one/react';

import { generateHelpers } from '@noodleseed/one/react';

export type AppType = ServerDefinition;

export const {
  useAppFlow,
  useCallTool,
  useOpenExternal,
  useSendFollowUpMessage,
  useToolInfo,
  useViewState,
} = generateHelpers<AppType>();
