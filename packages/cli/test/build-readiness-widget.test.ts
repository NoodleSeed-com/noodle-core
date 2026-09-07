import { describe, expect, it } from 'vitest';
import { BUILD_READINESS_WIDGET_STYLES } from '../src/plugin-mode/build-readiness-widget.css.js';
import {
  BUILD_READINESS_WIDGET_URI,
  renderBuildReadinessWidget,
} from '../src/plugin-mode/build-readiness-widget.js';

describe('Build Readiness widget', () => {
  it('renders a closed-CSP MCP App with the shared bridge and stable resource identity', () => {
    const rendered = renderBuildReadinessWidget();
    expect(rendered).toMatchObject({
      uri: BUILD_READINESS_WIDGET_URI,
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          prefersBorder: true,
        },
      },
    });
    expect(rendered.text).toContain('globalThis.ExtApps');
    expect(rendered.text).not.toMatch(/https?:\/\/(?:fonts|cdn)\./i);
  });

  it('uses a decision-first, bounded, mobile-first information hierarchy', () => {
    const { text } = renderBuildReadinessWidget();
    expect(text).toContain('data-bind="data.title"');
    expect(text).toContain('data-bind="data.summary"');
    expect(text).toContain('data-collection="data.stages"');
    expect(text).toContain('data-collection="data.findings"');
    expect(text).toContain('data-action-tool="run_build_gate"');
    expect(text).toContain('data-action-tool="deploy_build"');
    expect(text).toContain('data-action-tool="cancel_build_run"');
    expect(text).toContain('@media (max-width: 430px)');
    expect(text).toContain('min-height: 44px');
  });

  it('uses restrained platform typography, black primary actions, icons, and loading-only motion', () => {
    const { text } = renderBuildReadinessWidget();
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('"SF Pro Text"');
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('Roboto');
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('--ns-action: #0b0b0c');
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('border-radius: 999px');
    expect(text).toContain('<svg');
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('animation: readiness-shader');
    expect(BUILD_READINESS_WIDGET_STYLES).toContain('@media (prefers-reduced-motion: reduce)');
    expect(BUILD_READINESS_WIDGET_STYLES).not.toMatch(/font-weight:\s*(?:7|8|9)00/);
    expect(BUILD_READINESS_WIDGET_STYLES).not.toMatch(/#(?:f97316|ff(?:6b00|7a00|8a00))/i);
  });
});
