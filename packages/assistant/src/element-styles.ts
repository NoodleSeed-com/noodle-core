import { ASSISTANT_APP_VIEW_CSS } from './app-view-styles.js';
import { ASSISTANT_MOBILE_FULLSCREEN_MAX_WIDTH } from './element-layout.js';

export const ASSISTANT_ELEMENT_STYLES = `<style>
  *, *::before, *::after { box-sizing: border-box; }
  .visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
  .visually-hidden[hidden] { display: none !important; }
  :host { --ns-assistant-halo-launcher-action: #f4f4f5; --ns-assistant-halo-launcher-action-hover: #e4e4e7; --ns-assistant-halo-launcher-border: rgba(0,0,0,.04); --ns-assistant-halo-launcher-shadow: 0 1px 8px rgba(0,0,0,.04); --ns-assistant-halo-launcher-shadow-hover: 0 2px 12px rgba(0,0,0,.06); --ns-assistant-halo-send-button: #e4e4e7; --ns-assistant-halo-send-button-text: #09090b; box-sizing: border-box; color-scheme: light dark; font-family: var(--ns-assistant-font-family, var(--ns-assistant-default-font-family)); font-size: var(--ns-assistant-base-font-size, var(--ns-assistant-default-base-font-size)); line-height: var(--ns-assistant-line-height, var(--ns-assistant-default-line-height)); z-index: var(--ns-assistant-z-index, var(--ns-assistant-default-z-index)); -webkit-font-smoothing: antialiased; }
  :host([data-theme="dark"]) { --ns-assistant-halo-launcher-action: #3f3f46; --ns-assistant-halo-launcher-action-hover: #52525b; --ns-assistant-halo-launcher-border: rgba(255,255,255,.1); --ns-assistant-halo-launcher-shadow: 0 4px 20px rgba(0,0,0,.3); --ns-assistant-halo-launcher-shadow-hover: 0 6px 24px rgba(0,0,0,.4); --ns-assistant-halo-send-button: #3f3f46; --ns-assistant-halo-send-button-text: #fff; }
  :host([data-mode="floating"]) { position: fixed; }
  :host([data-mode="floating"][open]) { width: min(var(--ns-assistant-panel-width, var(--ns-assistant-default-panel-width)), 100vw); }
  button { font: inherit; }
  button, textarea, input, select { -webkit-tap-highlight-color: transparent; }
  .launcher { display: flex; align-items: center; justify-content: center; gap: 12px; width: var(--_ns-assistant-launcher-collapsed-width, max-content); min-height: 44px; padding: 10px 14px; color: var(--ns-assistant-launcher-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); background: var(--ns-assistant-launcher, color-mix(in srgb, var(--ns-assistant-panel, var(--ns-assistant-default-panel)) 50%, transparent)); border: 1px solid var(--ns-assistant-launcher-border, var(--ns-assistant-halo-launcher-border)); border-radius: 999px; box-shadow: var(--ns-assistant-halo-launcher-shadow), -6px 0 18px color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 20%, transparent), 6px 0 18px color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 20%, transparent), 0 0 40px color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 10%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: width .5s cubic-bezier(.25,1,.5,1), height .5s cubic-bezier(.25,1,.5,1), padding .5s cubic-bezier(.25,1,.5,1), gap .35s cubic-bezier(.25,1,.5,1), transform .6s cubic-bezier(.25,1,.5,1), background-color .3s ease, box-shadow .3s ease; will-change: width; }
  :host([data-presentation-ready]) .launcher { padding: 10px 12px; }
  .launcher[hidden] { display: none; }
  .launcher:hover { transform: scale(1.02); box-shadow: var(--ns-assistant-halo-launcher-shadow-hover), -6px 0 18px color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 20%, transparent), 6px 0 18px color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 20%, transparent); }
  .launcher-trigger, .launcher-form { min-width: 0; margin: 0; padding: 0; border: 0; background: transparent; font: inherit; }
  .launcher-trigger { display: flex; align-items: center; gap: 12px; min-height: 28px; color: var(--ns-assistant-launcher-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); cursor: text; }
  .launcher-label { padding-left: 6px; white-space: nowrap; font-size: 15px; line-height: 20px; }
  .launcher-arrow, .launcher-send { position: relative; display: grid; width: 28px; height: 28px; flex: 0 0 28px; place-items: center; border: 0; border-radius: 50%; color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: var(--ns-assistant-launcher-action, var(--ns-assistant-halo-launcher-action)); cursor: pointer; }
  .launcher-arrow:hover, .launcher-send:hover { background: var(--ns-assistant-launcher-action-hover, var(--ns-assistant-halo-launcher-action-hover)); }
  .launcher-arrow::before, .launcher-send::before { content: ''; width: 16px; height: 16px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 19V5M5 12l7-7 7 7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 19V5M5 12l7-7 7 7' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; }
  .launcher-form { display: none; flex: 1; align-items: center; gap: 12px; opacity: 0; pointer-events: none; }
  .launcher-input { width: 100%; min-width: 0; height: 28px; padding: 0 0 0 6px; color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: transparent; border: 0; outline: 0; box-shadow: none; appearance: none; font: inherit; font-size: 16px; line-height: 20px; }
  .launcher-input::placeholder { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  :host([launcher-expanded]) .launcher { width: min(400px, calc(100vw - 40px)); justify-content: flex-start; }
  :host([launcher-expanded]) .launcher-trigger { display: none; }
  :host([launcher-expanded]) .launcher-form { display: flex; opacity: 1; pointer-events: auto; }
  :host([data-launcher-style="bubble"]) .launcher { gap: 0; min-height: 0; padding: 6px; cursor: pointer; }
  :host([data-launcher-style="bubble"]) .launcher-trigger { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: pointer; }
  :host([data-launcher-style="bubble"]) .launcher-label, :host([data-launcher-style="bubble"]) .launcher-arrow, :host([data-launcher-style="bubble"]) .launcher-form { display: none; }
  :host([data-launcher-style="bubble"]) .launcher-visual { width: 32px; height: 32px; flex-basis: 32px; }
  .launcher-loader { display: none; width: 16px; height: 16px; flex: 0 0 16px; border: 2px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider)); border-top-color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); border-radius: 50%; animation: halo-spin .8s linear infinite; }
  :host([data-session-state="loading"]:not([data-presentation-ready])) .launcher-loader, :host([data-public-configuration-loading]:not([data-presentation-ready])) .launcher-loader { display: block; }
  :host([data-session-state="loading"]:not([data-presentation-ready])) .launcher > :not(.launcher-loader):not([data-session-status]), :host([data-public-configuration-loading]:not([data-presentation-ready])) .launcher > :not(.launcher-loader):not([data-session-status]) { display: none; }
  .panel { display: none; flex-direction: column; container-type: inline-size; width: 100%; max-width: 970px; height: min(85dvh, var(--ns-assistant-max-height, var(--ns-assistant-default-max-height)), calc(100dvh - 40px)); min-height: min(var(--ns-assistant-min-height, var(--ns-assistant-default-min-height)), calc(100dvh - 40px)); max-height: min(var(--ns-assistant-max-height, var(--ns-assistant-default-max-height)), calc(100dvh - 40px)); overflow: hidden; color: var(--ns-assistant-panel-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); background: var(--ns-assistant-panel, var(--ns-assistant-default-panel)); border: 1px solid var(--ns-assistant-panel-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: var(--ns-assistant-panel-radius, var(--ns-assistant-default-panel-radius)); box-shadow: var(--ns-assistant-shadow, var(--ns-assistant-default-shadow)); transform-origin: bottom center; isolation: isolate; animation: halo-panel-in .3s ease both; }
  :host([data-mode="floating"][open]) .panel { width: calc(100% - 40px); margin-inline: 20px; }
  :host([open][data-presentation-ready]) .panel { display: flex; }
  .panel { position: relative; }
  :host([open][data-presentation-ready]) .launcher { display: none; }
  :host([open]:not([data-presentation-ready])) .launcher { cursor: progress; opacity: .72; transform: none; }
  header { display: flex; flex: 0 0 auto; gap: 10px; align-items: center; min-height: 64px; padding: 16px 20px; color: var(--ns-assistant-header-text, inherit); background: var(--ns-assistant-header, transparent); border-bottom: 1px solid var(--ns-assistant-header-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); }
  header strong { flex: 1; font-size: 16px; font-weight: 600; letter-spacing: 0; }
  .brand-logo { display: block; max-width: 120px; max-height: 28px; object-fit: contain; }
  .close, .send { display: grid; place-items: center; border: 0; border-radius: var(--ns-assistant-button-radius, var(--ns-assistant-default-button-radius)); cursor: pointer; }
  .close { position: relative; width: 44px; height: 44px; margin: -6px; padding: 0; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); background: transparent; transition: background .15s ease, color .15s ease, transform .15s ease; }
  .close::before { content: ''; width: 20px; height: 20px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 6 12 12M18 6 6 18' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 6 12 12M18 6 6 18' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat; }
  .close:hover { color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: var(--ns-assistant-elevated, var(--ns-assistant-default-elevated)); }
  .close:active { transform: scale(.96); }
  .welcome { flex: 0 0 auto; padding: 24px 20px 8px; }
  .welcome h2 { margin: 0; font-size: 1.35em; line-height: 1.25; letter-spacing: 0; }
  .welcome p { max-width: 42ch; margin: 7px 0 0; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  .welcome:has(.empty-state[hidden]) { display: none; }
  :host([has-messages]) .welcome { display: none; }
  .input-section { flex: 0 0 auto; padding: 8px 16px 16px; }
  .suggested-prompts { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .suggested-prompts:empty { display: none; }
  .suggested-prompts button { position: relative; display: inline-flex; align-items: center; padding: 6px 12px; color: var(--ns-assistant-suggestion-text, var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text))); background: var(--ns-assistant-suggestion, transparent); border: 1px solid var(--ns-assistant-suggestion-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: 999px; cursor: pointer; font-size: 12px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: start; transition: background .2s ease, color .2s ease; }
  .suggested-prompts button::before { content: ''; position: absolute; inset: -6px -2px; }
  .suggested-prompts button:hover { color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: var(--ns-assistant-elevated, var(--ns-assistant-default-elevated)); }
  .messages-region { position: relative; display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .messages-region::before, .messages-region::after { content: ''; position: absolute; right: 0; left: 0; z-index: 1; height: 18px; pointer-events: none; opacity: 0; transition: opacity .18s ease; }
  .messages-region::before { top: 0; background: linear-gradient(to bottom, color-mix(in srgb, var(--ns-assistant-panel, var(--ns-assistant-default-panel)) 92%, transparent), transparent); }
  .messages-region::after { bottom: 0; background: linear-gradient(to top, color-mix(in srgb, var(--ns-assistant-panel, var(--ns-assistant-default-panel)) 92%, transparent), transparent); }
  .messages-region[data-can-scroll-up]::before, .messages-region[data-can-scroll-down]::after { opacity: 1; }
  .messages { flex: 1 1 auto; width: 100%; min-height: 0; padding: 16px 20px 72px; overflow-y: auto; background: var(--ns-assistant-canvas, transparent); overscroll-behavior: contain; scroll-behavior: smooth; }
  .messages::-webkit-scrollbar { width: 6px; }
  .messages::-webkit-scrollbar-thumb { background: var(--ns-assistant-divider, var(--ns-assistant-default-divider)); border-radius: 999px; }
  .message { width: fit-content; max-width: 88%; margin: 0 0 12px; padding: 0; border-radius: var(--ns-assistant-card-radius, var(--ns-assistant-default-card-radius)); background: transparent; white-space: pre-wrap; animation: halo-message-in .2s ease both; }
  .message > span, .message > .markdown { overflow-wrap: anywhere; }
  .message .avatar { float: left; width: 24px; height: 24px; margin-right: 9px; border-radius: 50%; object-fit: cover; }
  .message time { display: block; margin-top: 4px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: .75em; line-height: 1.2; }
  .message-copy { min-width: 44px; min-height: 32px; margin-top: 6px; padding: 4px 10px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); background: transparent; border: 0; border-radius: var(--ns-assistant-button-radius, var(--ns-assistant-default-button-radius)); cursor: pointer; font-size: .78em; opacity: 0; transition: opacity .15s ease, background .15s ease; }
  .message:hover .message-copy, .message:focus-within .message-copy { opacity: 1; }
  .conversation-status { margin: 4px auto 14px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: .82em; text-align: center; }
  .conversation-error { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin: 8px 0 16px; padding: 12px 14px; color: var(--ns-assistant-danger, var(--ns-assistant-default-danger)); border: 1px solid color-mix(in srgb, var(--ns-assistant-danger, var(--ns-assistant-default-danger)) 28%, transparent); border-radius: var(--ns-assistant-card-radius, var(--ns-assistant-default-card-radius)); background: color-mix(in srgb, var(--ns-assistant-danger, var(--ns-assistant-default-danger)) 7%, transparent); }
  .conversation-error p { margin: 0; }
  .conversation-error button { min-height: 44px; padding: 8px 14px; color: var(--ns-assistant-secondary-button-text, inherit); background: var(--ns-assistant-secondary-button, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated))); border: 1px solid var(--ns-assistant-secondary-button-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: var(--ns-assistant-button-radius, var(--ns-assistant-default-button-radius)); cursor: pointer; font-weight: 600; }
  .new-messages { position: absolute; left: 50%; bottom: 14px; z-index: 2; width: 44px; height: 44px; padding: 0; color: var(--ns-assistant-secondary-button-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); background: var(--ns-assistant-secondary-button, color-mix(in srgb, var(--ns-assistant-input, var(--ns-assistant-default-input)) 92%, transparent)); border: 1px solid var(--ns-assistant-secondary-button-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: var(--ns-assistant-button-radius, var(--ns-assistant-default-button-radius)); box-shadow: 0 8px 24px rgba(0,0,0,.12); transform: translateX(-50%); cursor: pointer; }
  .new-messages::before { content: ''; display: block; width: 18px; height: 18px; margin: auto; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; }
  .message.assistant { max-width: 100%; color: var(--ns-assistant-assistant-message-text, inherit); background: var(--ns-assistant-assistant-message, transparent); border: 1px solid var(--ns-assistant-assistant-message-border, transparent); }
  .message.user { display: grid; max-width: 85%; justify-items: start; gap: 3px; margin-left: auto; padding: 10px 16px; color: var(--ns-assistant-user-message-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); background: var(--ns-assistant-user-message, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated))); border: 1px solid var(--ns-assistant-user-message-border, transparent); border-radius: var(--ns-assistant-card-radius, var(--ns-assistant-default-card-radius)); font-size: 14px; }
  .message.user time { margin-top: 0; }
  .markdown { white-space: normal; }
  .markdown p { margin: 0 0 8px; }
  .markdown p:last-child { margin-bottom: 0; }
  .markdown strong, .markdown b { font-weight: 650; }
  .markdown em, .markdown i { font-style: italic; }
  .markdown a { color: var(--ns-assistant-link, var(--ns-assistant-default-link)); text-decoration: underline; text-underline-offset: 2px; }
  .markdown a:hover { opacity: .8; }
  .markdown code { padding: 2px 6px; color: var(--ns-assistant-code-text, inherit); border: 1px solid var(--ns-assistant-code-border, transparent); border-radius: 5px; background: var(--ns-assistant-code, var(--ns-assistant-default-code)); font-family: var(--ns-assistant-mono-font-family, var(--ns-assistant-default-mono-font-family)); font-size: .87em; }
  .markdown pre { margin: 10px 0; padding: 12px 14px; overflow-x: auto; color: var(--ns-assistant-code-text, inherit); border: 1px solid var(--ns-assistant-code-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: 10px; background: var(--ns-assistant-code, var(--ns-assistant-default-code)); white-space: pre; }
  .markdown pre code { padding: 0; background: transparent; font-size: .86em; }
  .markdown ul, .markdown ol { margin: 8px 0; padding-left: 22px; }
  .markdown li { margin: 3px 0; }
  .markdown blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider)); color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  .markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { margin: 14px 0 7px; line-height: 1.25; letter-spacing: 0; }
  .markdown h1:first-child, .markdown h2:first-child, .markdown h3:first-child { margin-top: 0; }
  .markdown h1 { font-size: 1.3em; } .markdown h2 { font-size: 1.18em; } .markdown h3 { font-size: 1.08em; }
  .message.assistant.streaming .markdown::after { content: ''; display: inline-block; width: 2px; height: 1em; margin-left: 3px; border-radius: 999px; background: var(--ns-assistant-accent, var(--ns-assistant-default-accent)); vertical-align: -.14em; animation: halo-caret-blink 1s steps(2, start) infinite; }
  .message.thinking > span { display: inline-block; color: transparent; background: linear-gradient(90deg, var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)) 25%, var(--ns-assistant-text, var(--ns-assistant-default-text)) 50%, var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)) 75%); background-size: 300% 100%; background-clip: text; -webkit-background-clip: text; font-style: italic; font-weight: 500; animation: halo-shimmer 2s linear infinite; }
  .tool-proposal { display: grid; gap: 12px; align-items: start; min-width: 0; max-width: 100%; margin: 8px 0 16px; padding: 18px; overflow-x: clip; color: var(--ns-assistant-confirmation-text, inherit); border: 1px solid var(--ns-assistant-confirmation-border, var(--ns-assistant-divider, var(--ns-assistant-default-divider))); border-radius: var(--ns-assistant-card-radius, 14px); background: var(--ns-assistant-confirmation, var(--ns-assistant-input, var(--ns-assistant-default-input))); animation: halo-message-in .2s ease both; }
  .proposal-eyebrow { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: .75em; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .tool-proposal h3 { margin: -4px 0 0; font-size: 1.08em; line-height: 1.3; letter-spacing: 0; }
  .proposal-description { margin: -4px 0 0; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  .proposal-arguments { display: grid; grid-template-columns: minmax(100px, .7fr) minmax(0, 1.3fr); gap: 8px 14px; min-width: 0; max-width: 100%; margin: 0; padding: 12px 0; border-block: 1px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider)); font-size: .9em; }
  .proposal-arguments .proposal-arguments { grid-column: 1 / -1; padding: 4px 0 0; border: 0; }
  .proposal-arguments dt { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  .proposal-arguments dt small { display: block; margin-top: 2px; font-size: .85em; line-height: 1.35; }
  .proposal-arguments dt, .proposal-arguments dd, .proposal-arguments ul, .proposal-arguments li { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .proposal-arguments dd { margin: 0; }
  .proposal-details { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: .86em; }
  .proposal-details summary { min-height: 36px; padding: 8px 0; cursor: pointer; font-weight: 600; }
  .proposal-details .proposal-arguments { margin-top: 4px; }
  .proposal-actions { position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; justify-content: end; padding-top: 12px; background: var(--ns-assistant-confirmation, var(--ns-assistant-input, var(--ns-assistant-default-input))); }
  .tool-proposal button { min-height: 44px; padding: 9px 16px; border: 1px solid var(--ns-assistant-secondary-button-border, transparent); border-radius: var(--ns-assistant-button-radius, var(--ns-assistant-default-button-radius)); color: var(--ns-assistant-secondary-button-text, var(--ns-assistant-text, var(--ns-assistant-default-text))); background: var(--ns-assistant-secondary-button, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated))); cursor: pointer; font-weight: 600; }
  .tool-proposal .proposal-accept, .tool-proposal .sign-in-action { color: var(--ns-assistant-primary-button-text, var(--ns-assistant-accent-text, var(--ns-assistant-default-accent-text))); background: var(--ns-assistant-primary-button, var(--ns-assistant-accent, var(--ns-assistant-default-accent))); border-color: var(--ns-assistant-primary-button-border, transparent); }
  .tool-proposal button:disabled { opacity: .55; cursor: not-allowed; }
  .sign-in .sign-in-badge { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 999px; color: var(--ns-assistant-accent, var(--ns-assistant-default-accent)); background: color-mix(in srgb, var(--ns-assistant-accent, var(--ns-assistant-default-accent)) 12%, transparent); }
  .sign-in .sign-in-badge::before { content: ''; width: 19px; height: 19px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2.2c-4.3 0-7.8 2.6-7.8 5.8v1h15.6v-1c0-3.2-3.5-5.8-7.8-5.8Z'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2.2c-4.3 0-7.8 2.6-7.8 5.8v1h15.6v-1c0-3.2-3.5-5.8-7.8-5.8Z'/%3E%3C/svg%3E") center / contain no-repeat; }
  .tool-proposal button { min-height: 45px; }
  .tool-result { display: grid; gap: 10px; margin: 8px 0 16px; padding: 16px; border: 1px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider)); border-radius: var(--ns-assistant-card-radius, 14px); background: var(--ns-assistant-assistant-message, var(--ns-assistant-elevated, var(--ns-assistant-default-elevated))); }
  .tool-result > strong { color: var(--ns-assistant-success, var(--ns-assistant-default-success)); }
  .input-request form { display: grid; gap: 10px; align-items: stretch; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .input-request form:focus-within { box-shadow: none; }
  .input-request label { display: grid; gap: 4px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: .9em; }
  .input-request input, .input-request select { width: 100%; min-height: 44px; padding: 8px 14px; color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: var(--ns-assistant-input, var(--ns-assistant-default-input)); border: 1px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider)); border-radius: var(--ns-assistant-input-radius, var(--ns-assistant-default-input-radius)); outline: 0; font: inherit; }
  .input-request select[multiple] { min-height: 88px; border-radius: var(--ns-assistant-card-radius, var(--ns-assistant-default-card-radius)); }
  .input-request input[type="checkbox"] { width: auto; min-height: auto; justify-self: start; accent-color: var(--ns-assistant-accent, var(--ns-assistant-default-accent)); }
  .input-request input:focus-visible, .input-request select:focus-visible { border-color: var(--ns-assistant-focus, var(--ns-assistant-default-focus)); box-shadow: 0 0 0 2px var(--ns-assistant-focus, var(--ns-assistant-default-focus)); }
  .input-request .proposal-actions { margin-top: 2px; }
  ${ASSISTANT_APP_VIEW_CSS}
  .composer { display: flex; flex: 0 0 auto; gap: 8px; align-items: center; min-height: 44px; margin: 0; padding: 8px 8px 8px 16px; color: var(--ns-assistant-composer-text, inherit); border: 1px solid var(--ns-assistant-composer-border, transparent); border-radius: var(--ns-assistant-input-radius, var(--ns-assistant-default-input-radius)); background: var(--ns-assistant-composer, var(--ns-assistant-input, var(--ns-assistant-default-input))); transition: border-color .15s ease, box-shadow .15s ease; }
  .composer:focus-within { border-color: var(--ns-assistant-focus, var(--ns-assistant-default-focus)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ns-assistant-focus, var(--ns-assistant-default-focus)) 32%, transparent); }
  textarea { flex: 1; min-height: 24px; max-height: 120px; resize: none; padding: 0; color: var(--ns-assistant-text, var(--ns-assistant-default-text)); background: transparent; border: 0; border-radius: 0; outline: 0; box-shadow: none; appearance: none; -webkit-appearance: none; font: inherit; font-size: 16px; line-height: 24px; }
  textarea::placeholder { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); }
  textarea:focus, textarea:focus-visible { outline: none; box-shadow: none; }
  button:focus-visible { outline: 3px solid var(--ns-assistant-focus, var(--ns-assistant-default-focus)); outline-offset: 2px; }
  .send { position: relative; display: block; width: 44px; height: 44px; flex: 0 0 44px; margin: -8px; padding: 0; overflow: visible; color: var(--ns-assistant-primary-button-text, var(--ns-assistant-halo-send-button-text)); border-radius: 999px; background: transparent; font-size: 0; line-height: 0; }
  .send::after { content: ''; position: absolute; top: 50%; left: 50%; z-index: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--ns-assistant-primary-button, var(--ns-assistant-halo-send-button)); transform: translate(-50%, -50%); }
  .send::before { content: ''; position: absolute; top: 50%; left: 50%; z-index: 1; width: 16px; height: 16px; background: currentColor; transform: translate(-50%, -50%); -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 19V5M5 12l7-7 7 7' fill='none' stroke='black' stroke-width='2.25' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 19V5M5 12l7-7 7 7' fill='none' stroke='black' stroke-width='2.25' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; }
  .send:hover::after { background: var(--ns-assistant-hover, var(--ns-assistant-default-hover)); }
  :host([busy]) .send::before { width: 13px; height: 13px; border-radius: 3px; -webkit-mask: none; mask: none; }
  .send:disabled, textarea:disabled { opacity: .55; cursor: not-allowed; }
  .legal { display: flex; gap: 12px; justify-content: center; padding: 0 12px 8px; font-size: .75em; }
  .legal:empty { display: none; }
  .legal a { color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); text-underline-offset: 2px; }
  .powered-by-row { display: flex; flex: 0 0 auto; justify-content: center; padding-bottom: 12px; }
  .powered-by-row[hidden] { display: none; }
  .powered-by { display: inline-flex; align-items: center; gap: 6px; margin: 0 auto 12px; padding: 0 16px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: 11px; line-height: 1; text-decoration: none; opacity: .7; transition: opacity .12s ease, color .12s ease; }
  .powered-by:hover { color: var(--ns-assistant-text, var(--ns-assistant-default-text)); opacity: 1; }
  .powered-by-icon { display: inline-flex; width: 14px; height: 14px; }
  .powered-by-name { font-weight: 500; }
  ::slotted([slot="conversation-footer"]) { display: block; padding: 0 16px 12px; color: var(--ns-assistant-muted-text, var(--ns-assistant-default-muted-text)); font-size: 11px; text-align: center; }
  @keyframes halo-panel-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }
  @keyframes halo-message-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @keyframes halo-shimmer { from { background-position: 100% center; } to { background-position: 0 center; } }
  @keyframes halo-caret-blink { 50% { opacity: 0; } }
  @keyframes halo-spin { to { transform: rotate(360deg); } }
  :host([data-density="compact"]) .welcome { padding: 20px 18px 12px; }
  @container (max-width: 440px) { .proposal-arguments { grid-template-columns: minmax(0, 1fr); } .proposal-arguments .proposal-arguments { grid-column: 1; } .proposal-actions { justify-content: stretch; } .proposal-actions button { flex: 1 1 100%; } }
  @media (max-width: ${ASSISTANT_MOBILE_FULLSCREEN_MAX_WIDTH}px) { :host([data-mode="floating"][mobile-fullscreen][open]) { inset: 0; width: 100%; transform: none; } :host([mobile-fullscreen][open]) .panel { width: 100%; max-width: none; height: 100dvh; min-height: 100dvh; max-height: 100dvh; margin: 0; border: 0; border-radius: 0; } :host([mobile-fullscreen]) header { padding-top: calc(16px + env(safe-area-inset-top)); padding-right: calc(20px + env(safe-area-inset-right)); padding-left: calc(20px + env(safe-area-inset-left)); } :host([mobile-fullscreen]) .messages { padding-right: calc(20px + env(safe-area-inset-right)); padding-left: calc(20px + env(safe-area-inset-left)); } :host([mobile-fullscreen]) .input-section { padding-right: calc(16px + env(safe-area-inset-right)); padding-bottom: calc(16px + env(safe-area-inset-bottom)); padding-left: calc(16px + env(safe-area-inset-left)); } :host([mobile-fullscreen]) .legal, :host([mobile-fullscreen]) ::slotted([slot="conversation-footer"]) { padding-bottom: max(10px, env(safe-area-inset-bottom)); } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } .messages { scroll-behavior: auto; } .message.assistant.streaming .markdown::after { animation: none; } }
  @media (forced-colors: active) { .message.thinking > span { color: CanvasText; background: none; } }
  @media (hover: none) { .message-copy { opacity: 1; } }
  @media (max-width: 560px) { :host([data-mode="floating"]:not([open])) { bottom: 20px; } :host([open]:not([mobile-fullscreen])) .panel { width: calc(100vw - 40px); max-height: calc(100dvh - 40px); } }
</style>`;
