/**
 * What a developer needs after deploying a public website surface: the id, and the line to paste.
 *
 * Printed by `noodle deploy` rather than documented, because the provisioning step it replaces is the
 * one most likely to be skipped — the developer never runs a command to create an embed, so there is
 * nothing to forget. A pure function returning lines so the exact bytes a developer copies are testable.
 *
 * The script URL points at the service just deployed to, so a snippet copied from a dev deploy talks to
 * dev; the tag's own `src` is what the loader derives its service origin from.
 */
export function publicEmbedSnippet(embedId: string, serviceUrl: string): readonly string[] {
  const src = `${serviceUrl.replace(/\/+$/, '')}/v1/assistant/embed.js`;
  return [
    'Assistant: public website surface is live.',
    `  Embed ID:  ${embedId}  (not a secret — safe in page source)`,
    '  Paste into your site:',
    `    <script src="${src}"`,
    `            data-embed-id="${embedId}" async></script>`,
    '  Or, in a React app:',
    "    import { NoodleAssistant } from '@noodleseed/assistant/react';",
    `    <NoodleAssistant embedId="${embedId}" />`,
  ];
}
