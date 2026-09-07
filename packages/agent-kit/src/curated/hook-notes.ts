// Curated one-line note for each widget React hook from `generateHelpers<AppType>()`.
//
// The hook NAMES are generated from packages/authoring/src/react.ts (see ../generated/surface.ts);
// this file is the human-authored prose the widgets-and-apps skill reference renders. The drift
// gate (../../test/skill-drift-gate.test.ts) fails when a hook has no note, so a new hook cannot
// ship without skill guidance. Keep each note one line and third-person.

export const HOOK_NOTES: Record<string, string> = {
  useToolInfo:
    'Read the complete invoking tool result: treat `{}` as pending, handle `isError`, validate every required `structuredContent` field and identifier, reject malformed success data, and render dependent actions only after validation succeeds.',
  useCallTool:
    'Call a tool from the widget — returns `{ status, callTool, callToolAsync, data, structuredContent, error, reset }`; target a model-visible tool or a hidden `tool` helper.',
  useViewState:
    'Persist per-widget UI state across re-renders and restores: `const [value, setValue] = useViewState("key", initial)`.',
  useAppFlow:
    'Manage named widget views with persisted params and back-stack state: `const flow = useAppFlow({ initialView, views })`.',
  useHandoff:
    'Open server-created HTTP(S) handoff URLs through the host with status/error state; domain policy still comes from `handoff.allowedDomains`.',
  useLayout:
    'Read host layout: `{ theme, displayMode, locale?, host?, supports? }` (`displayMode` is `"inline"`/`"pip"`/`"fullscreen"`) — adapt styling to the host theme and mode.',
  useBranding:
    'Read the server-level brand kit (`name`, `accent`, `surface`, `radius`, themed logo/mark/avatar URLs). Nothing is applied for you: widget CSS is yours, so map the values you need onto your own custom properties (e.g. `style={{ "--my-accent": useBranding().accent }}`) instead of hard-coding the brand color a second time.',
  useRequestDisplayMode:
    'Request a host-mediated layout change such as fullscreen; treat it as best-effort and keep inline rendering useful.',
  useOpenExternal:
    'Open an external link through the host (never `window.open`); the target origin must be listed in the server-level `handoff.allowedDomains`.',
  useSendFollowUpMessage:
    'Send a follow-up prompt to the model from a user interaction: `send({ prompt })` — trigger only from an explicit user action.',
  useUpdateModelContext:
    'Publish one compact, cohesive author-selected text/structured snapshot through the standard MCP Apps model-context channel; each call replaces the prior snapshot, so include every still-relevant field and check `useLayout().supports?.modelContext` first.',
  useWidgetLifecycle:
    'Calling the hook auto-publishes `mounted` and listens for host `cancelled`/`dismissed`; use its publisher for author-owned `submitted` or app milestones, include a complete safe replacement snapshot, and pair explicit submit/cancel with `useSendFollowUpMessage` when an immediate reply is wanted.',
  useWidgetReady:
    'Report when the standard MCP Apps bridge has connected; keep tool-backed controls disabled (or render loading) until this returns `true`.',
};
