import { type RuntimeArtifact, requiresToolConfirmation } from '@noodle-borg/compiler';

type ArtifactTool = RuntimeArtifact['tools'][number];

/** Classify the explicit author-owned confirmation contract identically in both MCP eras. */
export function toolRequiresConfirmation(tool: ArtifactTool | undefined): boolean {
  return tool !== undefined && requiresToolConfirmation(tool.annotations);
}
