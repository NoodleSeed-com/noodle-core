export const presentationStyles = `<style>
  :host([data-mode="floating"]) {
    bottom: var(--ns-assistant-edge-offset, var(--ns-assistant-default-edge-offset));
    left: 50%;
    transform: translateX(-50%);
  }
  :host([data-mode="floating"][data-position="bottom-left"]) {
    left: var(--ns-assistant-edge-offset, var(--ns-assistant-default-edge-offset));
    transform: none;
  }
  :host([data-mode="floating"][data-position="bottom-right"]) {
    right: var(--ns-assistant-edge-offset, var(--ns-assistant-default-edge-offset));
    left: auto;
    transform: none;
  }
  .panel {
    background: var(--ns-assistant-panel-background, var(--ns-assistant-presentation-panel-background));
    border: var(--ns-assistant-panel-border, var(--ns-assistant-presentation-border));
    border-radius: var(--ns-assistant-panel-radius, var(--ns-assistant-presentation-panel-radius, var(--ns-assistant-default-panel-radius)));
    box-shadow: var(--ns-assistant-shadow, var(--ns-assistant-presentation-shadow));
    backdrop-filter: blur(var(--ns-assistant-backdrop-blur, var(--ns-assistant-default-backdrop-blur)));
    -webkit-backdrop-filter: blur(var(--ns-assistant-backdrop-blur, var(--ns-assistant-default-backdrop-blur)));
  }
  :host([data-panel-surface="solid"]) .panel {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .launcher {
    position: relative;
    border-radius: var(--ns-assistant-launcher-radius, var(--ns-assistant-default-launcher-radius));
    isolation: isolate;
  }
  :host([data-launcher-style="bubble"]) .launcher {
    width: var(--ns-assistant-launcher-size, var(--ns-assistant-presentation-launcher-size));
    height: var(--ns-assistant-launcher-size, var(--ns-assistant-presentation-launcher-size));
  }
  :host([data-launcher-effect="pulse"]) .launcher {
    animation: assistant-launcher-pulse 2s ease-in-out infinite;
  }
  .launcher-visual {
    position: relative;
    display: grid;
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    place-items: center;
    border-radius: inherit;
  }
  .launcher-visual[hidden] { display: none; }
  .launcher-glyph, .composer-leading-glyph {
    display: block;
    width: 18px;
    height: 18px;
    background: currentColor;
    -webkit-mask-position: center;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-size: contain;
    mask-position: center;
    mask-repeat: no-repeat;
    mask-size: contain;
  }
  [data-icon="sparkles"] {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Zm6 11 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z'/%3E%3C/svg%3E");
  }
  [data-icon="chat"] {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4h16v12H9l-5 4V4Zm4 5h8v2H8V9Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4h16v12H9l-5 4V4Zm4 5h8v2H8V9Z'/%3E%3C/svg%3E");
  }
  [data-icon="none"] { display: none; }
  .launcher-glyph:is(img), .composer-leading-glyph:is(img), .header-mark-glyph:is(img) {
    background: none;
    object-fit: contain;
    -webkit-mask: none;
    mask: none;
  }
  .launcher-visual .launcher-glyph:is(img) {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    transition: width .5s cubic-bezier(.25,1,.5,1), height .5s cubic-bezier(.25,1,.5,1);
  }
  :host([data-launcher-style="bubble"]) .launcher-glyph:is(img) {
    width: 32px;
    height: 32px;
  }
  .launcher-status {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border: 2px solid var(--ns-assistant-panel, var(--ns-assistant-default-panel));
    border-radius: 50%;
    background: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text));
  }
  .launcher-status[data-state="loading"] {
    background: var(--ns-assistant-warning, var(--ns-assistant-default-warning));
    animation: assistant-launcher-pulse 1.2s ease-in-out infinite;
  }
  .launcher-status[data-state="ready"] {
    background: var(--ns-assistant-success, var(--ns-assistant-default-success));
    box-shadow: 0 0 9px color-mix(in srgb, var(--ns-assistant-success, var(--ns-assistant-default-success)) 70%, transparent);
  }
  .launcher-status[data-state="error"] {
    background: var(--ns-assistant-danger, var(--ns-assistant-default-danger));
  }

  .header-mark {
    position: relative;
    display: grid;
    width: 26px;
    height: 26px;
    flex: 0 0 26px;
    place-items: center;
    color: var(--ns-assistant-accent, var(--ns-assistant-default-accent));
  }
  .header-mark[data-variant="status"] .header-mark-core {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ns-assistant-success, var(--ns-assistant-default-success));
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--ns-assistant-success, var(--ns-assistant-default-success)) 16%, transparent);
  }
  .header-mark-glyph {
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
  .header-actions {
    display: flex;
    align-items: center;
  }
  .header-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--presentation-tone, var(--ns-assistant-accent, var(--ns-assistant-default-accent))) 22%, transparent);
    border-radius: 999px;
    color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text));
    background: color-mix(in srgb, var(--presentation-tone, var(--ns-assistant-accent, var(--ns-assistant-default-accent))) 7%, transparent);
    font-family: var(--ns-assistant-mono-font-family, var(--ns-assistant-default-mono-font-family));
    font-size: 9px;
    font-weight: 650;
    letter-spacing: .11em;
    text-transform: uppercase;
  }
  [data-tone="success"] { --presentation-tone: var(--ns-assistant-success, var(--ns-assistant-default-success)); }
  [data-tone="warning"] { --presentation-tone: var(--ns-assistant-warning, var(--ns-assistant-default-warning)); }
  [data-tone="danger"] { --presentation-tone: var(--ns-assistant-danger, var(--ns-assistant-default-danger)); }
  [data-tone="neutral"] { --presentation-tone: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  .tone-indicator {
    display: inline-block;
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    border-radius: 50%;
    background: var(--presentation-tone);
    box-shadow: 0 0 8px color-mix(in srgb, var(--presentation-tone) 72%, transparent);
  }

  .empty-state { min-width: 0; }
  .composer-leading {
    display: grid;
    width: 20px;
    height: 20px;
    flex: 0 0 20px;
    place-items: center;
    color: var(--ns-assistant-accent, var(--ns-assistant-default-accent));
  }
  .composer-leading-glyph { width: 15px; height: 15px; }
  form[data-shape="rounded"] {
    border-radius: var(--ns-assistant-input-radius, var(--ns-assistant-default-input-radius));
  }
  form[data-shape="pill"] { border-radius: 999px; }
  .send[data-icon="paper-plane"]::before {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m3 4 18 8-18 8 3-7 9-1-9-1-3-7Z'/%3E%3C/svg%3E");
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m3 4 18 8-18 8 3-7 9-1-9-1-3-7Z'/%3E%3C/svg%3E");
  }

  :host([data-message-user-style="accent"]) .message.user {
    color: var(--ns-assistant-accent-text, var(--ns-assistant-default-accent-text));
    background: var(--ns-assistant-accent, var(--ns-assistant-default-accent));
  }
  :host([data-message-user-style="accent"]) .message.user time {
    color: color-mix(in srgb, var(--ns-assistant-accent-text, var(--ns-assistant-default-accent-text)) 72%, transparent);
  }
  :host([data-message-assistant-style="bubble"]) .message.assistant {
    padding: 10px 14px;
    background: var(--ns-assistant-input, var(--ns-assistant-default-input));
  }

  @keyframes assistant-launcher-pulse { 50% { opacity: .55; transform: scale(.9); } }

  @media (max-width: 640px) {
    .header-badge { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .launcher, .launcher-status { animation: none !important; }
  }
</style>`;
