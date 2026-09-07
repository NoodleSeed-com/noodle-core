export const DEVELOPER_WIDGET_STYLES = `
@layer reset, tokens, base, components, utilities;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  button, input, select, textarea { font: inherit; }
}

@layer tokens {
  :root {
    color-scheme: light dark;
    --ns-bg: var(--color-background-primary, Canvas);
    --ns-bg-subtle: var(--color-background-secondary, color-mix(in srgb, Canvas 94%, CanvasText));
    --ns-text: var(--color-text-primary, CanvasText);
    --ns-muted: var(--color-text-secondary, #667085);
    --ns-border: var(--color-border-secondary, #d8dee8);
    --ns-accent: var(--color-background-accent, #2563eb);
    --ns-on-accent: var(--color-text-on-accent, #ffffff);
    --ns-danger: var(--color-text-danger, #b42318);
    --ns-success: var(--color-text-success, #067647);
    --ns-warning: var(--color-text-warning, #b54708);
    --ns-font: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
    --ns-space-1: var(--space-1, 0.25rem);
    --ns-space-2: var(--space-2, 0.5rem);
    --ns-space-3: var(--space-3, 0.75rem);
    --ns-space-4: var(--space-4, 1rem);
    --ns-space-5: var(--space-5, 1.25rem);
    --ns-space-6: var(--space-6, 1.5rem);
    --ns-radius: var(--radius-lg, 0.875rem);
    --ns-radius-sm: var(--radius-md, 0.625rem);
  }
}

@layer base {
  body {
    background: var(--ns-bg);
    color: var(--ns-text);
    font-family: var(--ns-font);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  main { display: grid; gap: var(--ns-space-4); padding: var(--ns-space-4); }
  h1, h2, h3, p, dl, dd { margin: 0; }
  h1 { font-size: clamp(1.25rem, 4vw, 1.6rem); line-height: 1.2; }
  h2 { font-size: 1rem; line-height: 1.3; }
  h3 { font-size: 0.9375rem; line-height: 1.35; }
  a { color: inherit; }
  button:focus-visible { outline: 3px solid color-mix(in srgb, var(--ns-accent) 55%, transparent); outline-offset: 2px; }
}

@layer components {
  .widget-header, .panel-header, .action-row {
    align-items: flex-start;
    display: flex;
    gap: var(--ns-space-3);
    justify-content: space-between;
  }
  .eyebrow {
    color: var(--ns-muted);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin-bottom: var(--ns-space-1);
    text-transform: uppercase;
  }
  .lede, .panel-header p, .metric p { color: var(--ns-muted); margin-top: var(--ns-space-1); }
  .status-badge {
    background: var(--ns-bg-subtle);
    border: 1px solid var(--ns-border);
    border-radius: 999px;
    flex: none;
    font-size: 0.78rem;
    font-weight: 650;
    padding: var(--ns-space-1) var(--ns-space-3);
  }
  .panel {
    background: var(--ns-bg-subtle);
    border: 1px solid var(--ns-border);
    border-radius: var(--ns-radius);
    display: grid;
    gap: var(--ns-space-4);
    padding: var(--ns-space-4);
  }
  .facts, .metrics { display: grid; gap: var(--ns-space-2); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); }
  .fact, .metric {
    background: var(--ns-bg);
    border: 1px solid var(--ns-border);
    border-radius: var(--ns-radius-sm);
    min-width: 0;
    padding: var(--ns-space-3);
  }
  dt { color: var(--ns-muted); font-size: 0.76rem; font-weight: 650; }
  dd { font-size: 0.9rem; font-weight: 650; margin-top: var(--ns-space-1); overflow-wrap: anywhere; }
  .metric dd { font-size: 1.35rem; }
  .collection { display: grid; gap: var(--ns-space-2); }
  .collection-card {
    background: var(--ns-bg);
    border: 1px solid var(--ns-border);
    border-radius: var(--ns-radius-sm);
    display: grid;
    gap: var(--ns-space-1);
    padding: var(--ns-space-3);
  }
  .collection-card p { color: var(--ns-muted); }
  .empty-state, .notice, .action-status {
    border: 1px dashed var(--ns-border);
    border-radius: var(--ns-radius-sm);
    color: var(--ns-muted);
    display: block;
    padding: var(--ns-space-3);
  }
  .notice[data-tone="warn"] { border-style: solid; color: var(--ns-warning); }
  .primary-action {
    background: var(--ns-accent);
    border: 0;
    border-radius: var(--ns-radius-sm);
    color: var(--ns-on-accent);
    cursor: pointer;
    font-weight: 700;
    min-height: 2.65rem;
    padding: var(--ns-space-2) var(--ns-space-4);
  }
  .primary-action[aria-busy="true"] { cursor: wait; opacity: 0.7; }
  .danger-action { background: var(--ns-danger); }
  .tag-list { display: flex; flex-wrap: wrap; gap: var(--ns-space-2); }
  .tag {
    background: var(--ns-bg);
    border: 1px solid var(--ns-border);
    border-radius: 999px;
    padding: var(--ns-space-1) var(--ns-space-2);
  }
}

@layer utilities {
  .visually-hidden {
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
  [hidden] { display: none !important; }
  [data-missing="true"] { color: var(--ns-muted); font-weight: 500; }
  @media (max-width: 32rem) {
    .widget-header, .panel-header, .action-row { align-items: stretch; flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
}
`;
