import type { ServerDefinition } from '@noodleseed/one';

export {
  ActionBar,
  AppShell,
  AsyncBoundary,
  ChoiceGroup,
  createViewStore,
  DataCard,
  DataList,
  Feedback,
  Field,
  Form,
  HandoffButton,
  QuantityStepper,
  ShellNav,
  StatusBadge,
  SubmitButton,
  View,
  ViewStack,
} from '@noodleseed/one/react';

import { generateHelpers } from '@noodleseed/one/react';

export type AppType = ServerDefinition;

export const {
  useCallTool,
  useAppFlow,
  useHandoff,
  useLayout,
  useOpenExternal,
  useSendFollowUpMessage,
  useToolInfo,
  useUpdateModelContext,
  useViewState,
  useWidgetLifecycle,
  useWidgetReady,
} = generateHelpers<AppType>();
