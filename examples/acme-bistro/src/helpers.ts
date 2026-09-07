import type { ServerDefinition } from '@noodleseed/one';
import { generateHelpers } from '@noodleseed/one/react';

export type AppType = ServerDefinition;

export const { useBranding, useCallTool, useLayout, useOpenExternal, useToolInfo, useViewState } =
  generateHelpers<AppType>();
