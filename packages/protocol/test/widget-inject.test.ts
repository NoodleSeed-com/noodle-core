import { describe, expect, it } from 'vitest';
import { mapResourceContents } from '../src/index.js';
import { injectWidgetBridge } from '../src/widget/inject.js';

const MCP_APP = 'text/html;profile=mcp-app';

describe('injectWidgetBridge', () => {
  it('injects the ext-apps bridge into an mcp-app widget body, before </body>', () => {
    const body = '<!doctype html><html><body><span data-bind="severity"></span></body></html>';
    const out = injectWidgetBridge(MCP_APP, body);
    expect(out).toContain('globalThis.ExtApps'); // the vendored bundle
    expect(out).toContain('app.connect'); // bootstrap opens the host bridge
    expect(out).toContain('data-bind'); // bootstrap binds the tool result
    expect(out).toContain('data-action'); // bootstrap wires actions
    expect(out).toContain('<span data-bind="severity"></span>'); // author body preserved
    expect(out.indexOf('<script type="module">')).toBeLessThan(out.lastIndexOf('</body>'));
  });

  it('advertises the W2.5 interactivity wiring (callServerTool / ontoolinput / openLink)', () => {
    const out = injectWidgetBridge(MCP_APP, '<html><body></body></html>');
    expect(out).toContain('callServerTool'); // UI-initiated server tools/call
    expect(out).toContain('ontoolinput'); // tool-call arguments → data-bind-input
    expect(out).toContain('openLink'); // host-mediated external links
    expect(out).toContain('requestDisplayMode'); // display-mode action
    expect(out).toContain('data-bind-input'); // the input-binding convention
  });

  it('is a no-op for non-widget mime types', () => {
    const body = '# Markdown';
    expect(injectWidgetBridge('text/markdown', body)).toBe(body);
    expect(injectWidgetBridge(undefined, body)).toBe(body);
  });

  it('is idempotent (skips a body that already inlines the bundle)', () => {
    const already = '<html><body><script>globalThis.ExtApps={}</script></body></html>';
    expect(injectWidgetBridge(MCP_APP, already)).toBe(already);
  });

  it('appends the bridge when there is no </body>', () => {
    const out = injectWidgetBridge(MCP_APP, '<div>x</div>');
    expect(out.startsWith('<div>x</div>')).toBe(true);
    expect(out).toContain('globalThis.ExtApps');
  });

  it('neutralizes </script> inside the bundle so it cannot close the host script tag early', () => {
    const out = injectWidgetBridge(MCP_APP, '<html><body></body></html>');
    // Only the closing tag of our injected block is a literal </script>.
    const closers = out.match(/<\/script>/gi) ?? [];
    expect(closers.length).toBe(1);
  });
});

describe('mapResourceContents (widget bridge)', () => {
  it('injects the bridge when serving an mcp-app resource', () => {
    const r = mapResourceContents('ui://demo/w', MCP_APP, { value: '<html><body>x</body></html>' });
    expect(r.contents[0]?.mimeType).toBe(MCP_APP);
    expect(r.contents[0]?.text).toContain('globalThis.ExtApps');
    expect(r.contents[0]?.text).toContain('>x<'); // author content kept
  });

  it('does not inject auth tokens, local config values, or secret-shaped runtime material', () => {
    const r = mapResourceContents('ui://demo/w', MCP_APP, {
      value: '<html><body><span data-bind="message"></span></body></html>',
    });
    const text = r.contents[0]?.text ?? '';
    expect(text).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_|\\.env\\.noodle/);
    expect(text).not.toContain('svc-token');
  });

  it('does not inject for a normal text resource', () => {
    const r = mapResourceContents('docs://x', 'text/markdown', { value: '# X' });
    expect(r.contents[0]?.text).toBe('# X');
  });
});
