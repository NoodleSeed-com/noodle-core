/**
 * Author-time analysis of a compiled artifact: what `noodle check` reports before anything is deployed.
 *
 * Separate from the CLI because none of it is a command. Every module here takes a `RuntimeArtifact` and
 * returns findings — no argv, no process exit, no terminal. That makes the rules testable on their own
 * and reusable by anything that holds an artifact, and it keeps the CLI's package to the command surface
 * it is named for.
 */

export * from './audit-embedded-assistant.js';
export * from './mcp-apps-audit.js';
export * from './mcp-apps-chatgpt.js';
export * from './tool-design-audit.js';
export * from './widget-quality-audit.js';
