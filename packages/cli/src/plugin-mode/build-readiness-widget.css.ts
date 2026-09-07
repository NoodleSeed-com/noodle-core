export const BUILD_READINESS_WIDGET_STYLES = `
@layer reset, tokens, base, components, responsive, motion;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; min-width: 0; padding: 0; }
  button { font: inherit; }
  h1, h2, p, ol, ul { margin: 0; }
  ol, ul { list-style: none; padding: 0; }
  [hidden] { display: none !important; }
}

@layer tokens {
  :root {
    color-scheme: light dark;
    --ns-bg: var(--color-background-primary, #ffffff);
    --ns-surface: var(--color-background-secondary, #f7f7f8);
    --ns-text: var(--color-text-primary, #17171a);
    --ns-muted: var(--color-text-secondary, #6b6b73);
    --ns-border: var(--color-border-secondary, #e4e4e8);
    --ns-action: #0b0b0c;
    --ns-on-action: #ffffff;
    --ns-ok: var(--color-text-success, #16845b);
    --ns-warn: var(--color-text-warning, #9a6700);
    --ns-error: var(--color-text-danger, #c13c37);
    --ns-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", Roboto, "Segoe UI", system-ui, sans-serif;
    --ns-radius: 22px;
    --ns-radius-sm: 14px;
    --ns-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 12px 34px rgb(0 0 0 / 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ns-bg: var(--color-background-primary, #18181b);
      --ns-surface: var(--color-background-secondary, #202024);
      --ns-text: var(--color-text-primary, #f5f5f6);
      --ns-muted: var(--color-text-secondary, #a7a7af);
      --ns-border: var(--color-border-secondary, #35353b);
      --ns-action: #f4f4f5;
      --ns-on-action: #111113;
      --ns-shadow: none;
    }
  }
}

@layer base {
  body {
    background: transparent;
    color: var(--ns-text);
    font-family: var(--ns-font);
    font-size: 15px;
    font-weight: 400;
    line-height: 1.45;
    text-rendering: optimizeLegibility;
  }
  button:focus-visible {
    outline: 2px solid var(--ns-text);
    outline-offset: 3px;
  }
}

@layer components {
  .readiness-card {
    background: var(--ns-bg);
    border: 1px solid var(--ns-border);
    border-radius: var(--ns-radius);
    box-shadow: var(--ns-shadow);
    display: grid;
    gap: 20px;
    max-width: 560px;
    min-width: 0;
    overflow: hidden;
    padding: 22px;
    position: relative;
    width: 100%;
  }
  .loading-shader {
    background: linear-gradient(90deg, transparent 0%, rgb(120 119 198 / 0.16) 38%, rgb(255 255 255 / 0.5) 50%, rgb(120 119 198 / 0.16) 62%, transparent 100%);
    height: 3px;
    inset: 0 0 auto;
    pointer-events: none;
    position: absolute;
    transform: translateX(-100%);
  }
  .brand-row, .decision-row, .action-row, .stage-row, .finding-row {
    align-items: center;
    display: flex;
    min-width: 0;
  }
  .brand-row { color: var(--ns-muted); gap: 8px; }
  .brand-mark {
    align-items: center;
    background: var(--ns-text);
    border-radius: 7px;
    color: var(--ns-bg);
    display: inline-flex;
    height: 24px;
    justify-content: center;
    width: 24px;
  }
  .brand-row p { font-size: 13px; letter-spacing: 0.01em; }
  .decision { display: grid; gap: 10px; }
  .decision-row { align-items: flex-start; gap: 12px; justify-content: space-between; }
  .decision-copy { display: grid; gap: 6px; min-width: 0; }
  h1 { font-size: clamp(22px, 6vw, 28px); font-weight: 500; letter-spacing: -0.035em; line-height: 1.12; }
  h2 { font-size: 13px; font-weight: 500; letter-spacing: 0.01em; }
  .summary { color: var(--ns-muted); max-width: 46ch; overflow-wrap: anywhere; }
  .decision-badge {
    align-items: center;
    background: var(--ns-surface);
    border: 1px solid var(--ns-border);
    border-radius: 999px;
    color: var(--ns-muted);
    display: inline-flex;
    flex: none;
    font-size: 12px;
    gap: 6px;
    max-width: 44%;
    min-height: 30px;
    overflow-wrap: anywhere;
    padding: 5px 10px;
  }
  .decision-badge::before, .stage-dot {
    background: currentColor;
    border-radius: 999px;
    content: "";
    flex: none;
    height: 7px;
    width: 7px;
  }
  [data-tone="ok"] { color: var(--ns-ok); }
  [data-tone="warn"] { color: var(--ns-warn); }
  [data-tone="error"] { color: var(--ns-error); }
  [data-tone="neutral"] { color: var(--ns-muted); }
  .section { border-top: 1px solid var(--ns-border); display: grid; gap: 12px; padding-top: 18px; }
  .section-heading { align-items: baseline; display: flex; justify-content: space-between; }
  .section-note { color: var(--ns-muted); font-size: 12px; }
  .stage-list { display: grid; gap: 2px; }
  .stage-row {
    border-radius: 10px;
    color: var(--ns-text);
    gap: 10px;
    justify-content: space-between;
    min-height: 36px;
    padding: 7px 8px;
  }
  .stage-row:hover { background: var(--ns-surface); }
  .stage-label { align-items: center; display: flex; gap: 10px; min-width: 0; }
  .stage-label span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage-status { color: var(--ns-muted); font-size: 12px; text-transform: capitalize; }
  .stage-row[data-tone="ok"] .stage-dot { background: var(--ns-ok); }
  .stage-row[data-tone="warn"] .stage-dot { background: var(--ns-warn); }
  .stage-row[data-tone="error"] .stage-dot { background: var(--ns-error); }
  .stage-row[data-tone="neutral"] .stage-dot { background: var(--ns-muted); }
  .finding-list { display: grid; gap: 8px; }
  .finding-row {
    align-items: flex-start;
    background: var(--ns-surface);
    border-radius: var(--ns-radius-sm);
    gap: 10px;
    padding: 11px 12px;
  }
  .finding-row svg { color: var(--ns-warn); flex: none; margin-top: 2px; }
  .finding-copy { display: grid; gap: 2px; min-width: 0; }
  .finding-code { font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
  .finding-message { color: var(--ns-muted); font-size: 13px; overflow-wrap: anywhere; }
  .empty-findings { color: var(--ns-muted); font-size: 13px; padding: 4px 0; }
  .action-row { flex-wrap: wrap; gap: 8px; }
  .action {
    align-items: center;
    border: 1px solid var(--ns-border);
    border-radius: 999px;
    cursor: pointer;
    display: inline-flex;
    font-weight: 500;
    gap: 8px;
    justify-content: center;
    min-height: 44px;
    padding: 10px 17px;
    transition: transform 140ms ease, background-color 140ms ease, opacity 140ms ease;
  }
  .action:hover { transform: translateY(-1px); }
  .action:active { transform: translateY(0); }
  .action[aria-busy="true"] { cursor: wait; opacity: 0.62; }
  .action-primary { background: var(--ns-action); border-color: var(--ns-action); color: var(--ns-on-action); }
  .action-secondary { background: transparent; color: var(--ns-text); }
  .action-cancel { color: var(--ns-error); }
  .action-status { color: var(--ns-muted); font-size: 12px; min-height: 18px; }
  .icon { display: block; height: 16px; width: 16px; }
}

@layer responsive {
  @media (max-width: 430px) {
    body { font-size: 14px; }
    .readiness-card { border-radius: 18px; gap: 18px; padding: 18px 16px; }
    .decision-row { align-items: stretch; flex-direction: column; }
    .decision-badge { align-self: flex-start; max-width: 100%; }
    .action-row { align-items: stretch; flex-direction: column; }
    .action { width: 100%; }
    .stage-row { padding-inline: 4px; }
  }
}

@layer motion {
  .loading-shader { animation: readiness-shader 1.25s cubic-bezier(.22,.72,.22,1) 1 forwards; }
  @keyframes readiness-shader {
    0% { opacity: 0; transform: translateX(-100%); }
    18% { opacity: 1; }
    82% { opacity: 1; }
    100% { opacity: 0; transform: translateX(100%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading-shader { animation: none; display: none; }
    .action { transition: none; }
  }
}
`;
