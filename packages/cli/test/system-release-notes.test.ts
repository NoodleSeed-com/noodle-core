import { describe, expect, it } from 'vitest';
import { reconcileSystemReleaseNotes } from '../../../scripts/system-release-notes.mjs';

const evidence = {
  pluginMarketplace: {
    commit: '1'.repeat(40),
    tree: `sha256:${'a'.repeat(64)}`,
  },
  copilotPlugin: {
    commit: '2'.repeat(40),
    tree: `sha256:${'b'.repeat(64)}`,
  },
};

const pluginSection = `### Plugin marketplace

- commit: \`${evidence.pluginMarketplace.commit}\`
- tree: \`${evidence.pluginMarketplace.tree}\``;

const copilotSection = `### GitHub Copilot plugin

- commit: \`${evidence.copilotPlugin.commit}\`
- tree: \`${evidence.copilotPlugin.tree}\``;

describe('System Release finalized notes reconciliation', () => {
  it('appends missing projection sections once and replays byte-identically', () => {
    const original = '# System r501\n\nExisting release notes.\n';
    const reconciled = reconcileSystemReleaseNotes(original, evidence);

    expect(reconciled).toBe(`${original}\n${pluginSection}\n\n${copilotSection}\n`);
    expect(reconcileSystemReleaseNotes(reconciled, evidence)).toBe(reconciled);
  });

  it('preserves valid finalized notes byte-identically', () => {
    const notes = `# System r501\n\n${pluginSection}\n\nExisting detail.\n\n${copilotSection}\n`;

    expect(reconcileSystemReleaseNotes(notes, evidence)).toBe(notes);
  });

  it('rejects projection evidence swapped between the two sections', () => {
    const notes = `# System r501

### Plugin marketplace

- commit: \`${evidence.copilotPlugin.commit}\`
- tree: \`${evidence.copilotPlugin.tree}\`

### GitHub Copilot plugin

- commit: \`${evidence.pluginMarketplace.commit}\`
- tree: \`${evidence.pluginMarketplace.tree}\`
`;

    expect(() => reconcileSystemReleaseNotes(notes, evidence)).toThrow(
      /Plugin marketplace.*commit/i,
    );
  });

  it('does not accept expected evidence placed after the next heading', () => {
    const notes = `# System r501

### Plugin marketplace

- commit: \`${evidence.copilotPlugin.commit}\`
- tree: \`${evidence.copilotPlugin.tree}\`

### Unrelated evidence

- commit: \`${evidence.pluginMarketplace.commit}\`
- tree: \`${evidence.pluginMarketplace.tree}\`

${copilotSection}
`;

    expect(() => reconcileSystemReleaseNotes(notes, evidence)).toThrow(
      /Plugin marketplace.*commit/i,
    );
  });

  it('rejects duplicate expected headings even when their evidence matches', () => {
    const notes = `# System r501\n\n${pluginSection}\n\n${pluginSection}\n\n${copilotSection}\n`;

    expect(() => reconcileSystemReleaseNotes(notes, evidence)).toThrow(
      /duplicate.*Plugin marketplace/i,
    );
  });

  it('rejects ambiguous projection evidence within one bounded section', () => {
    const notes = `# System r501

### Plugin marketplace

- commit: \`${evidence.pluginMarketplace.commit}\`
- commit: \`${'3'.repeat(40)}\`
- tree: \`${evidence.pluginMarketplace.tree}\`

${copilotSection}
`;

    expect(() => reconcileSystemReleaseNotes(notes, evidence)).toThrow(
      /Plugin marketplace.*commit/i,
    );
  });
});
