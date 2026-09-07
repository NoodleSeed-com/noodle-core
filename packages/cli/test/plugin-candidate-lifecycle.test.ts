import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPublishableSkills } from '@noodle-borg/agent-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCopilotPluginArchive } from '../../../scripts/lib/copilot-plugin-artifact.mjs';
import { validatePluginMarketplaceArchive } from '../../../scripts/lib/plugin-marketplace-artifact.mjs';
import {
  createPluginReleasePlan,
  PLUGIN_CONTENT_HASH_PLACEHOLDER,
  PLUGIN_SOURCE_SHA_PLACEHOLDER,
  PLUGIN_VERSION_PLACEHOLDER,
} from '../../../scripts/lib/plugin-release-plan.mjs';
import {
  renderCopilotReleaseProjection,
  renderReleaseCopilotPlugin,
} from '../../../scripts/render-copilot-plugin.mjs';
import {
  inspectPluginMarketplaceTree,
  renderMarketplaceReleaseProjection,
  renderReleaseMarketplace,
} from '../../../scripts/render-plugin-marketplace.mjs';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(40);
const RELEASE_SHARED = {
  mode: 'release' as const,
  agentKitVersion: '2.3.4',
  cliVersion: '5.6.7',
  developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
  developerMcpCapabilityVersion: '1',
};
const RELEASE_PLAN_SCRIPT = fileURLToPath(
  new URL('../../../scripts/lib/plugin-release-plan.mjs', import.meta.url),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle plugin lifecycle ü-'));
  roots.push(root);
  return root;
}

function candidateAgentKit(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"2.3.4"}\n');
  for (const file of renderPublishableSkills().filter(
    (candidate) =>
      candidate.agentTarget === 'claude-code' && candidate.path.includes('/references/'),
  )) {
    const destination = join(root, file.path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, file.content);
  }
}

function releasePlan() {
  const shared = {
    ...RELEASE_SHARED,
    version: PLUGIN_VERSION_PLACEHOLDER,
    pluginContentHash: PLUGIN_CONTENT_HASH_PLACEHOLDER,
  };
  return createPluginReleasePlan({
    ...shared,
    projections: {
      pluginMarketplace: renderMarketplaceReleaseProjection(shared),
      copilotPlugin: renderCopilotReleaseProjection({
        ...shared,
        sourceSha: PLUGIN_SOURCE_SHA_PLACEHOLDER,
      }),
    },
  });
}

function render(root: string) {
  const agentKitTree = join(root, 'Agent Kit candidate');
  candidateAgentKit(agentKitTree);
  return renderReleaseMarketplace({
    agentKitTree,
    ...RELEASE_SHARED,
    sourceSha: SOURCE_SHA,
    releasePlan: releasePlan(),
    stagingDirectory: join(root, 'Marketplace candidate'),
    archivePath: join(root, 'plugin marketplace.tgz'),
  });
}

function renderCopilot(root: string) {
  const agentKitTree = join(root, 'Agent Kit candidate');
  candidateAgentKit(agentKitTree);
  return renderReleaseCopilotPlugin({
    agentKitTree,
    ...RELEASE_SHARED,
    sourceSha: SOURCE_SHA,
    releasePlan: releasePlan(),
    stagingDirectory: join(root, 'Copilot candidate'),
    archivePath: join(root, 'copilot plugin.tgz'),
  });
}

describe('plugin candidate lifecycle', () => {
  it('rejects missing and unsupported plugin release plan options before reading files', () => {
    const missingValue = spawnSync(
      process.execPath,
      [RELEASE_PLAN_SCRIPT, '--previous', '--output', 'ignored.json'],
      { encoding: 'utf8' },
    );
    expect(missingValue.status).toBe(1);
    expect(missingValue.stderr).toContain('plugin-release-plan: invalid option --previous');

    const unsupported = spawnSync(
      process.execPath,
      [RELEASE_PLAN_SCRIPT, '--unsupported', 'value'],
      { encoding: 'utf8' },
    );
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('plugin-release-plan: unsupported option --unsupported');
  });

  it('replaces only the generated candidate tree and rerenders byte-identically', () => {
    const root = temporary();
    const first = render(root);
    const marketplace = join(root, 'Marketplace candidate');
    writeFileSync(join(marketplace, 'unowned-file.txt'), 'remove on generated-tree replacement\n');
    writeFileSync(join(root, 'operator-evidence.txt'), 'preserve outside generated tree\n');

    const second = render(root);
    expect(second).toEqual(first);
    expect(existsSync(join(marketplace, 'unowned-file.txt'))).toBe(false);
    expect(readFileSync(join(root, 'operator-evidence.txt'), 'utf8')).toContain('preserve');
    for (const path of [
      'docs/installation.md',
      'docs/how-it-works.md',
      'docs/security-and-permissions.md',
      'docs/troubleshooting.md',
    ]) {
      expect(readFileSync(join(marketplace, path), 'utf8').length).toBeGreaterThan(0);
    }
    expect(inspectPluginMarketplaceTree(marketplace)).toBe(first.treeHash);
  });

  it('round-trips the immutable archive and rejects tampered bytes', () => {
    const root = temporary();
    const metadata = render(root);
    const archive = join(root, 'plugin marketplace.tgz');
    expect(validatePluginMarketplaceArchive(archive, metadata)).toEqual({
      treeHash: metadata.treeHash,
      archiveIntegrity: metadata.archiveIntegrity,
    });

    appendFileSync(archive, 'tampered');
    expect(() => validatePluginMarketplaceArchive(archive, metadata)).toThrow(/integrity/i);
  });

  it('binds release metadata provenance to the compatibility manifest inside the archive', () => {
    const root = temporary();
    const metadata = render(root);
    const archive = join(root, 'plugin marketplace.tgz');
    expect(() =>
      validatePluginMarketplaceArchive(archive, {
        ...metadata,
        contentHash: `sha256:${'f'.repeat(64)}`,
      }),
    ).toThrow(/content.*provenance|contentHash/i);
    expect(() =>
      validatePluginMarketplaceArchive(archive, {
        ...metadata,
        agentKitVersion: '9.9.9',
      }),
    ).toThrow(/Agent Kit.*provenance|agentKitVersion/i);
    expect(() =>
      validatePluginMarketplaceArchive(archive, {
        ...metadata,
        pluginVersion: '9.9.9',
      }),
    ).toThrow(/pluginVersion/i);
  });

  it('replaces and round-trips the Copilot candidate without touching operator evidence', () => {
    const root = temporary();
    const first = renderCopilot(root);
    const candidate = join(root, 'Copilot candidate');
    writeFileSync(join(candidate, 'unowned-file.txt'), 'remove with generated tree\n');
    writeFileSync(join(root, 'operator-evidence.txt'), 'preserve outside generated tree\n');

    const second = renderCopilot(root);
    expect(second).toEqual(first);
    expect(existsSync(join(candidate, 'unowned-file.txt'))).toBe(false);
    expect(readFileSync(join(root, 'operator-evidence.txt'), 'utf8')).toContain('preserve');
    expect(validateCopilotPluginArchive(join(root, 'copilot plugin.tgz'), second)).toEqual({
      treeHash: second.treeHash,
      archiveIntegrity: second.archiveIntegrity,
    });
  });

  it('persists one plan and requires both release CLIs to consume it', () => {
    const root = temporary();
    const agentKitTree = join(root, 'Agent Kit candidate');
    candidateAgentKit(agentKitTree);
    const previous = join(root, 'previous.json');
    const releasePlanPath = join(root, 'plugin-release-plan.json');
    const marketplaceMetadata = join(root, 'plugin-marketplace.json');
    const copilotMetadata = join(root, 'copilot-plugin.json');
    writeFileSync(previous, '{}\n');

    execFileSync(process.execPath, [
      RELEASE_PLAN_SCRIPT,
      '--previous',
      previous,
      '--agent-kit-version',
      '2.3.4',
      '--cli-version',
      '5.6.7',
      '--developer-mcp-url',
      'https://cloud.noodleseed.dev/developer/mcp',
      '--developer-mcp-capability-version',
      '1',
      '--output',
      releasePlanPath,
    ]);
    expect(existsSync(releasePlanPath)).toBe(true);

    const sharedArguments = [
      '--release-agent-kit',
      agentKitTree,
      '--agent-kit-version',
      '2.3.4',
      '--cli-version',
      '5.6.7',
      '--developer-mcp-url',
      'https://cloud.noodleseed.dev/developer/mcp',
      '--developer-mcp-capability-version',
      '1',
      '--source-sha',
      SOURCE_SHA,
      '--release-plan',
      releasePlanPath,
    ];
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../../../scripts/render-plugin-marketplace.mjs', import.meta.url)),
      ...sharedArguments,
      '--archive',
      join(root, 'plugin-marketplace.tgz'),
      '--metadata',
      marketplaceMetadata,
      join(root, 'Marketplace CLI candidate'),
    ]);
    execFileSync(process.execPath, [
      fileURLToPath(new URL('../../../scripts/render-copilot-plugin.mjs', import.meta.url)),
      ...sharedArguments,
      '--archive',
      join(root, 'copilot-plugin.tgz'),
      '--metadata',
      copilotMetadata,
      join(root, 'Copilot CLI candidate'),
    ]);

    const direct = JSON.parse(readFileSync(marketplaceMetadata, 'utf8'));
    const copilot = JSON.parse(readFileSync(copilotMetadata, 'utf8'));
    expect(direct.pluginVersion).toBe(copilot.pluginVersion);
    expect(direct.contentHash).toBe(copilot.contentHash);
  });

  it('carries both projection records and archives through every candidate handoff', () => {
    const candidate = readFileSync(
      new URL('../../../scripts/system-release-candidate.sh', import.meta.url),
      'utf8',
    );
    const bind = readFileSync(
      new URL('../../../scripts/system-release-bind-candidate.sh', import.meta.url),
      'utf8',
    );
    const deploy = readFileSync(
      new URL('../../../.github/workflows/deploy-pipeline.yml', import.meta.url),
      'utf8',
    );
    const release = readFileSync(
      new URL('../../../.github/workflows/system-release.yml', import.meta.url),
      'utf8',
    );

    for (const artifact of ['plugin-marketplace.json', 'copilot-plugin.json']) {
      expect(candidate).toContain(artifact);
      expect(deploy).toContain(artifact);
    }
    for (const archive of ['plugin-marketplace.tgz', 'copilot-plugin.tgz']) {
      expect(candidate).toContain(archive);
      expect(deploy).toContain(archive);
      expect(release).toContain(archive);
    }
    expect(bind).toContain('--plugin-marketplace "$bundle/plugin-marketplace.json"');
    expect(bind).toContain('--copilot-plugin "$bundle/copilot-plugin.json"');
    expect(bind).toContain('--npm-artifact-report "$bundle/npm-artifact-report.json"');
    expect(deploy).toMatch(
      /cp previous\.json packages\.json packages-to-publish\.json npm-artifact-report\.json \\\r?\n\s+plugin-marketplace\.json plugin-marketplace\.tgz \\\r?\n\s+copilot-plugin\.json copilot-plugin\.tgz candidate-bundle\//,
    );
  });
});
