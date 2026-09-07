import { describe, expect, it } from 'vitest';
import { harnessHtml } from '../src/devtools-preview.js';

describe('devtools Design UI', () => {
  it('renders the live annotation workspace instead of a coming-soon placeholder', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });

    expect(html).toContain('id="mode-design"');
    expect(html).not.toContain('mode__soon');
    expect(html).not.toContain('Coming soon');
    expect(html).toContain('aria-label="Design inspector"');
    expect(html).toContain('id="design-select-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Annotations off');
    expect(html).toContain('aria-label="Describe this change"');
    expect(html).toContain('Background color');
    expect(html).toContain('Border radius');
    expect(html).toContain('Undo');
    expect(html).toContain('Redo');
    expect(html).toContain('Send to agent');
  });

  it('shows an honest, expandable ledger with the full details for each saved tweak', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    const canvasStart = html.indexOf('<div class="design-canvas">');
    const tweaksPanel = html.indexOf('id="design-tweaks-panel"');
    const inspectorStart = html.indexOf(
      '<aside class="design-inspector" role="region" aria-label="Design inspector">',
    );

    expect(html).toContain('id="design-tweaks-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('0 tweaks');
    expect(html).toContain('id="design-tweaks-panel"');
    expect(html).toContain('class="design-tweaks-popover"');
    expect(html).toContain('role="region" aria-label="Saved design tweaks"');
    expect(tweaksPanel).toBeGreaterThan(canvasStart);
    expect(tweaksPanel).toBeLessThan(inspectorStart);
    expect(html).toContain('Tweak "');
    expect(html).toContain('Target');
    expect(html).toContain('Selector');
    expect(html).toContain('Request');
    expect(html).toContain('Visual changes');
    expect(html).toContain('Copy tweak');
    expect(html).toContain('Unsaved');
    expect(html).toContain('if(!annotations.length){');
    expect(html).toContain('closeTweaks(false,true)');
    expect(html).toContain('tweaksPanel.contains(event.target)');
    expect(html).toContain('event.key==="Escape"');
    expect(html).toContain('backdrop-filter:blur(22px) saturate(1.15)');
    expect(html).toContain('z-index:20');
    expect(html).toContain('.design-tweaks-popover.is-open');
    expect(html).not.toContain('tweaksPanel.scrollIntoView');
    expect(html).not.toContain('class="design-section design-tweaks-panel"');
  });

  it('composes selection, preview, persistence, and honest clipboard delivery behavior', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });

    expect(html).toContain('window.NoodleDesignElement');
    expect(html).toContain('window.NoodleDesign');
    expect(html).toContain('setSelecting');
    expect(html).toContain('state.selectionId');
    expect(html).toContain('data-noodle-design-target');
    expect(html).toContain('requestJson("/design/session?');
    expect(html).toContain('requestJson("/design/finalize"');
    expect(html).toContain('Agent instruction copied. Paste it into your coding agent.');
    expect(html).toContain('@media (max-width:760px)');
    expect(html).toContain('@media (prefers-reduced-motion:reduce)');
    expect(html).not.toContain('#1677ff');
    expect(html).not.toContain('#111827');
    expect(html).toContain('#design-intent:focus-visible');
    expect(html).toContain('.design-input:focus-visible');
  });

  it('replaces MCP activity with the Design inspector while Design mode is active', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });

    expect(html).toContain('document.body.classList.toggle("design-mode",d)');
    expect(html).toContain('activity.appendChild(inspector)');
    expect(html).toContain('activity.setAttribute("aria-label","Design tools")');
    expect(html).toContain('body.design-mode .pane--log>.rail-heading--activity');
    expect(html).toContain('body.design-mode .pane--log>#log-list');
    expect(html).toContain(
      'body.design-mode .design-workspace{grid-template-columns:minmax(0,1fr)}',
    );
  });
});
