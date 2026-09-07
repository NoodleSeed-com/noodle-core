import { afterEach, describe, expect, it } from 'vitest';
import { globalLayout, type LayoutState } from '../src/react/bridge.js';

afterEach(() => {
  delete (globalThis as { __noodleLayout?: Partial<LayoutState> }).__noodleLayout;
});

describe('host-neutral React layout contract', () => {
  it('preserves standard MCP Apps host context with safe fallbacks', () => {
    (globalThis as { __noodleLayout?: Partial<LayoutState> }).__noodleLayout = {
      theme: 'dark',
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { maxWidth: 420, maxHeight: 680 },
      locale: 'ar-PK',
      timeZone: 'Asia/Karachi',
      platform: 'mobile',
      deviceCapabilities: { touch: true, hover: false },
      safeAreaInsets: { top: 12, right: 0, bottom: 18, left: 0 },
      host: 'portable-test-host',
      supports: { fullscreen: true, pip: true, openExternal: false },
    };

    expect(globalLayout()).toEqual({
      theme: 'dark',
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { maxWidth: 420, maxHeight: 680 },
      locale: 'ar-PK',
      timeZone: 'Asia/Karachi',
      platform: 'mobile',
      deviceCapabilities: { touch: true, hover: false },
      safeAreaInsets: { top: 12, right: 0, bottom: 18, left: 0 },
      host: 'portable-test-host',
      supports: { fullscreen: true, pip: true, openExternal: false },
    });
  });
});
