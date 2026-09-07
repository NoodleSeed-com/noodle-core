/** Positive allowlist of `server.assistant` fields that may reach the browser. */
export const ASSISTANT_BROWSER_UI_FIELDS = [
  'theme',
  'layout',
  'behavior',
  'labels',
  'presentation',
  'suggestedPrompts',
  'privacyUrl',
  'termsUrl',
  'locale',
  'direction',
  'webmcp',
] as const;
