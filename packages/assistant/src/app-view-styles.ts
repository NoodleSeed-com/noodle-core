/** Shared MCP App card styles for the managed assistant and the standalone App-view element. */
export const ASSISTANT_APP_VIEW_CSS = `
  .noodle-app-card { position: relative; display: grid; gap: 8px; width: 100%; margin: 4px 0 16px; overflow: hidden; color: var(--ns-assistant-app-text, inherit); border: 1px solid var(--ns-assistant-app-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider, var(--ns-app-view-border, #d1d5db)))); border-radius: var(--ns-assistant-card-radius, var(--ns-assistant-default-card-radius, 12px)); background: var(--ns-assistant-app, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated, var(--ns-app-view-surface, #fff)))); }
  .noodle-app-title { padding: 10px 12px 0; font-size: .86em; font-weight: 650; }
  .noodle-app-fullscreen-exit { position: absolute; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); z-index: 1; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text, var(--ns-app-view-muted, #6b7280))); border: 1px solid var(--ns-assistant-secondary-button-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider, var(--ns-app-view-border, #d1d5db)))); border-radius: 999px; background: var(--ns-assistant-secondary-button, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated, var(--ns-app-view-surface, #fff)))); box-shadow: 0 6px 20px rgba(0,0,0,.14); cursor: pointer; font: inherit; transition: color .15s ease, background .15s ease, transform .15s ease; }
  .noodle-app-fullscreen-exit[hidden] { display: none; }
  .noodle-app-fullscreen-exit::before { content: ''; width: 18px; height: 18px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 6 12 12M18 6 6 18' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 6 12 12M18 6 6 18' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat; }
  .noodle-app-fullscreen-exit:hover { color: var(--ns-assistant-text, var(--ns-assistant-default-text, inherit)); background: var(--ns-assistant-hover, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated, var(--ns-app-view-surface, #fff)))); }
  .noodle-app-fullscreen-exit:focus-visible { outline: 3px solid var(--ns-assistant-focus, var(--ns-assistant-default-focus, #2563eb)); outline-offset: 2px; }
  .noodle-app-fullscreen-exit:active { transform: scale(.96); }
  .noodle-app-frame { display: block; width: 100%; min-height: 120px; overflow: hidden; border: 0; background: transparent; }
  .noodle-app-fallback { padding: 14px 16px; font-size: 13px; color: var(--ns-assistant-muted, var(--ns-assistant-default-muted, var(--ns-app-view-muted, #6b7280))); }
  .noodle-app-card[data-fullscreen] { position: fixed; inset: 0; z-index: 2; margin: 0; border-radius: 0; background: var(--ns-assistant-panel, var(--ns-assistant-default-panel, var(--ns-app-view-surface, #fff))); }
  .noodle-app-card[data-fullscreen] .noodle-app-frame { height: 100% !important; }
`;

export const ASSISTANT_APP_VIEW_STYLES = `<style>
  *, *::before, *::after { box-sizing: border-box; }
  :host { --ns-app-view-surface: #fff; --ns-app-view-border: #d1d5db; --ns-app-view-muted: #6b7280; display: block; min-width: 0; color: #111827; color-scheme: light; font: inherit; }
  :host([data-theme="dark"]) { --ns-app-view-surface: #17191f; --ns-app-view-border: #343741; --ns-app-view-muted: #a7adb8; color: #f3f4f6; color-scheme: dark; }
  :host([hidden]) { display: none; }
  ${ASSISTANT_APP_VIEW_CSS}
</style>`;
