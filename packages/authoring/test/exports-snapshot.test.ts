import { describe, expect, it } from 'vitest';

/**
 * Exports snapshot gate (ADR 0150): the public authoring surface is governed, not frozen — adding or
 * removing a public name must update these lists in the same diff, so the surface can never change
 * silently. The `@noodleseed/one` shim parity gate lives in `packages/cli/test/authoring-shim.test.ts`.
 */

const BARREL_EXPORTS = [
  'ConnectorBuilder',
  'algolia',
  'annotations',
  'asset',
  'authenticatedWebsite',
  'bind',
  'clientCredentials',
  'connection',
  'connector',
  'customerAuth',
  'customerEndpoint',
  'embeddedAssistant',
  'externalExchange',
  'file',
  'firecrawl',
  'gmailConnector',
  'googleWorkloadIdentity',
  'handoffSession',
  'isServerDefinition',
  'knowledge',
  'managedCollection',
  'managedSecret',
  'meilisearch',
  'noodleManaged',
  'noodlePlatform',
  'noodlePlatformCatalog',
  'openAICompatible',
  'prompt',
  'publicWebsite',
  'resource',
  'secret',
  'server',
  'site',
  'tavily',
  'tool',
  'variable',
  'when',
  'widgetResult',
  'z',
] as const;

const REACT_EXPORTS = [
  'Action',
  'ActionBar',
  'AppShell',
  'AsyncBoundary',
  'Avatar',
  'AvatarGroup',
  'Checkbox',
  'ChoiceGroup',
  'Collection',
  'DataCard',
  'DataList',
  'EmptyState',
  'ErrorState',
  'ExpandButton',
  'Fact',
  'Feedback',
  'Field',
  'Flow',
  'Form',
  'Frame',
  'FullscreenShell',
  'HandoffButton',
  'InlineCard',
  'InlineCarousel',
  'InlineList',
  'Input',
  'LoadingState',
  'Menu',
  'Overlay',
  'Popover',
  'QuantityStepper',
  'RadioGroup',
  'Region',
  'SegmentedControl',
  'Select',
  'ShellHeader',
  'ShellNav',
  'Slider',
  'Spinner',
  'StatusBadge',
  'SubmitButton',
  'Switch',
  'Textarea',
  'Tooltip',
  'View',
  'ViewNav',
  'ViewStack',
  'createViewStore',
  'generateHelpers',
  'useAppFlow',
  'useBranding',
  'useCallTool',
  'useHandoff',
  'useLayout',
  'useOpenExternal',
  'useRequestDisplayMode',
  'useSendFollowUpMessage',
  'useToolInfo',
  'useUpdateModelContext',
  'useViewState',
  'useWidgetLifecycle',
  'useWidgetReady',
] as const;

describe('public SDK exports snapshot (ADR 0150)', () => {
  it('the barrel exposes exactly the committed public surface', async () => {
    const barrel = await import('../src/index.js');
    expect(Object.keys(barrel).sort()).toEqual([...BARREL_EXPORTS]);
  });

  it('the ./react entry exposes exactly the committed public surface', async () => {
    const react = await import('../src/react.js');
    expect(Object.keys(react).sort()).toEqual([...REACT_EXPORTS]);
  });
});
