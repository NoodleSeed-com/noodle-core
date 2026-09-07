import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCopilotPluginArchive,
  extractCopilotPluginArchive,
  inspectCopilotPluginTree,
  validateCopilotPluginArchive,
} from '../../../scripts/lib/copilot-plugin-artifact.mjs';
import { validateCopilotPluginContract } from '../../../scripts/lib/copilot-plugin-contract.mjs';
import * as deterministicPluginArchive from '../../../scripts/lib/deterministic-plugin-archive.mjs';
import {
  createPluginReleasePlan,
  PLUGIN_CONTENT_HASH_PLACEHOLDER,
  PLUGIN_SOURCE_SHA_PLACEHOLDER,
  PLUGIN_VERSION_PLACEHOLDER,
} from '../../../scripts/lib/plugin-release-plan.mjs';
import {
  main as renderCopilotPluginMain,
  renderCopilotReleaseProjection,
  renderReleaseCopilotPlugin,
} from '../../../scripts/render-copilot-plugin.mjs';
import { renderMarketplaceReleaseProjection } from '../../../scripts/render-plugin-marketplace.mjs';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(40);
const SHARED = {
  agentKitVersion: '2.3.4',
  cliVersion: '5.6.7',
  developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
  developerMcpCapabilityVersion: '1',
};
const EXACT_PATHS = [
  '.mcp.json',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'noodle-plugin-compatibility.json',
  'plugin.json',
  'skills/noodle-seed/SKILL.md',
  'skills/noodle-seed/scripts/noodle-plugin.mjs',
];

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `noodle-copilot-plugin-${name}-`));
  roots.push(root);
  return root;
}

function candidateAgentKit(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ version: SHARED.agentKitVersion })}\n`,
  );
}

function releasePlan(previousRelease?: Record<string, unknown>) {
  const normalized = {
    ...SHARED,
    mode: 'release' as const,
    version: PLUGIN_VERSION_PLACEHOLDER,
    pluginContentHash: PLUGIN_CONTENT_HASH_PLACEHOLDER,
  };
  return createPluginReleasePlan({
    previousRelease,
    ...SHARED,
    projections: {
      pluginMarketplace: renderMarketplaceReleaseProjection(normalized),
      copilotPlugin: renderCopilotReleaseProjection({
        ...normalized,
        sourceSha: PLUGIN_SOURCE_SHA_PLACEHOLDER,
      }),
    },
  });
}

function render(root: string) {
  const agentKitTree = join(root, 'agent-kit');
  candidateAgentKit(agentKitTree);
  const stagingDirectory = join(root, 'copilot-plugin');
  const archivePath = join(root, 'copilot-plugin.tgz');
  const metadata = renderReleaseCopilotPlugin({
    agentKitTree,
    ...SHARED,
    releasePlan: releasePlan(),
    sourceSha: SOURCE_SHA,
    stagingDirectory,
    archivePath,
  });
  return { metadata, stagingDirectory, archivePath };
}

function tarHeader(path: string, size: number, type = '0', link = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function craftedArchiveEntries(
  root: string,
  name: string,
  entries: Array<{ path: string; type?: string; link?: string }>,
): string {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const content = type === '0' ? Buffer.from('unsafe') : Buffer.alloc(0);
    parts.push(
      tarHeader(entry.path, content.length, type, entry.link ?? ''),
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  const archive = join(root, `crafted-${name}.tgz`);
  const bytes = Buffer.concat([...parts, Buffer.alloc(1024)]);
  writeFileSync(archive, gzipSync(bytes));
  return archive;
}

function craftedArchive(root: string, name: string, path: string, type = '0', link = ''): string {
  return craftedArchiveEntries(root, name, [{ path, type, link }]);
}

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    return entry.isFile() ? [path.slice(root.length + 1)] : [];
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Copilot plugin release artifact', () => {
  it('selects normalized ownership flags for GNU tar and bsdtar', () => {
    const metadataArgsForTar = (
      deterministicPluginArchive as typeof deterministicPluginArchive & {
        metadataArgsForTar?: (version: string) => string[];
      }
    ).metadataArgsForTar;

    expect(metadataArgsForTar).toBeTypeOf('function');
    expect(metadataArgsForTar?.('tar (GNU tar) 1.35')).toEqual([
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--format=ustar',
    ]);
    expect(metadataArgsForTar?.('bsdtar 3.7.4 - libarchive 3.7.4')).toEqual([
      '--uid',
      '0',
      '--gid',
      '0',
      '--uname',
      'root',
      '--gname',
      'root',
      '--format',
      'ustar',
      '--no-mac-metadata',
      '--no-xattrs',
    ]);
  });

  it('rejects missing metadata before writing release bytes', () => {
    const root = temporary('missing-metadata');
    const agentKitTree = join(root, 'agent-kit');
    const stagingDirectory = join(root, 'copilot-plugin');
    const archivePath = join(root, 'copilot-plugin.tgz');
    const releasePlanPath = join(root, 'release-plan.json');
    candidateAgentKit(agentKitTree);
    writeFileSync(releasePlanPath, `${JSON.stringify(releasePlan())}\n`);

    expect(() =>
      renderCopilotPluginMain([
        stagingDirectory,
        '--release-agent-kit',
        agentKitTree,
        '--agent-kit-version',
        SHARED.agentKitVersion,
        '--cli-version',
        SHARED.cliVersion,
        '--developer-mcp-url',
        SHARED.developerMcpUrl,
        '--developer-mcp-capability-version',
        SHARED.developerMcpCapabilityVersion,
        '--source-sha',
        SOURCE_SHA,
        '--release-plan',
        releasePlanPath,
        '--archive',
        archivePath,
      ]),
    ).toThrow(/--metadata is required/);
    expect(existsSync(stagingDirectory)).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('renders exactly eight approved files with parsed release provenance', () => {
    const { metadata, stagingDirectory } = render(temporary('contract'));
    const paths = filesUnder(stagingDirectory).sort();
    expect(paths).toEqual(EXACT_PATHS);
    expect(validateCopilotPluginContract(stagingDirectory)).toMatchObject({
      pluginVersion: metadata.pluginVersion,
      agentKitVersion: SHARED.agentKitVersion,
      cliVersion: SHARED.cliVersion,
      developerMcpCapabilityVersion: SHARED.developerMcpCapabilityVersion,
      sourceSha: SOURCE_SHA,
      contentHash: metadata.contentHash,
    });
    expect(JSON.parse(readFileSync(join(stagingDirectory, 'plugin.json'), 'utf8'))).toMatchObject({
      name: 'noodle-seed',
      version: metadata.pluginVersion,
      repository: 'https://github.com/NoodleSeed-com/copilot-plugin',
      license: 'Apache-2.0',
      skills: './skills/',
      mcpServers: './.mcp.json',
    });
    expect(readFileSync(join(stagingDirectory, 'LICENSE'), 'utf8')).toMatch(
      /Apache License\s+Version 2\.0/,
    );
  });

  it('produces identical canonical trees and archive bytes in clean directories', () => {
    const first = render(temporary('deterministic-first'));
    const second = render(temporary('deterministic-second'));
    expect(first.metadata).toEqual(second.metadata);
    expect(readFileSync(first.archivePath)).toEqual(readFileSync(second.archivePath));
    expect(inspectCopilotPluginTree(first.stagingDirectory)).toBe(first.metadata.treeHash);
    expect(validateCopilotPluginArchive(first.archivePath, first.metadata)).toEqual({
      treeHash: first.metadata.treeHash,
      archiveIntegrity: first.metadata.archiveIntegrity,
    });
    appendFileSync(join(first.stagingDirectory, 'README.md'), '\n<!-- changed -->\n');
    expect(inspectCopilotPluginTree(first.stagingDirectory)).not.toBe(first.metadata.treeHash);

    appendFileSync(first.archivePath, 'tampered');
    expect(() => validateCopilotPluginArchive(first.archivePath, first.metadata)).toThrow(
      /integrity/i,
    );
  });

  it('labels launcher syntax failures as Copilot plugin contract errors', () => {
    const { stagingDirectory } = render(temporary('launcher-syntax-diagnostic'));
    writeFileSync(
      join(stagingDirectory, 'skills/noodle-seed/scripts/noodle-plugin.mjs'),
      '#!/usr/bin/env node\nconst broken = ;\n',
    );

    expect(() => validateCopilotPluginContract(stagingDirectory)).toThrow(
      /Copilot plugin launcher syntax is invalid[\s\S]*Unexpected token/i,
    );
  });

  it('rejects traversal, symlinks, unapproved roots, and missing files', () => {
    const root = temporary('unsafe');
    expect(() =>
      extractCopilotPluginArchive(
        craftedArchive(root, 'traversal', '../outside'),
        join(root, 'traversal'),
      ),
    ).toThrow(/unsafe path|traversal/i);
    expect(() =>
      extractCopilotPluginArchive(
        craftedArchive(root, 'symlink', 'plugin.json', '2', '../outside'),
        join(root, 'symlink-archive'),
      ),
    ).toThrow(/symlink|link/i);

    const extra = render(temporary('extra'));
    writeFileSync(join(extra.stagingDirectory, 'SECURITY.md'), 'unapproved\n');
    expect(() => inspectCopilotPluginTree(extra.stagingDirectory)).toThrow(/unapproved|exact/i);

    const missing = render(temporary('missing'));
    rmSync(join(missing.stagingDirectory, 'plugin.json'));
    expect(() => inspectCopilotPluginTree(missing.stagingDirectory)).toThrow(
      /missing.*plugin\.json/i,
    );

    const linked = render(temporary('linked'));
    rmSync(join(linked.stagingDirectory, 'README.md'));
    symlinkSync(
      join(linked.stagingDirectory, 'CHANGELOG.md'),
      join(linked.stagingDirectory, 'README.md'),
    );
    expect(() => createCopilotPluginArchive(linked.stagingDirectory, linked.archivePath)).toThrow(
      /symlink/i,
    );
  });

  it('rejects canonical alias duplicates, hard links, and unsupported entries', () => {
    const root = temporary('archive-entry-types');
    const aliases = craftedArchiveEntries(root, 'aliases', [
      { path: 'bin/noodle-plugin.mjs' },
      { path: 'bin/./noodle-plugin.mjs' },
    ]);
    expect(() => extractCopilotPluginArchive(aliases, join(root, 'aliases'))).toThrow(/duplicate/i);

    const hardLink = craftedArchive(root, 'hard-link', 'plugin.json', '1', 'README.md');
    expect(() => extractCopilotPluginArchive(hardLink, join(root, 'hard-link'))).toThrow(
      /hard link|link/i,
    );

    const unsupported = craftedArchive(root, 'unsupported-entry', 'plugin.json', '3');
    expect(() => extractCopilotPluginArchive(unsupported, join(root, 'unsupported'))).toThrow(
      /unsupported/i,
    );
  });

  it('rejects version, source, Agent Kit, CLI, MCP capability, and content-hash mismatches', () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['version', { pluginVersion: '9.9.9' }, /pluginVersion|version.*provenance/i],
      ['source', { sourceSha: 'b'.repeat(40) }, /source.*provenance|sourceSha/i],
      ['Agent Kit', { agentKitVersion: '9.9.9' }, /Agent Kit.*provenance|agentKitVersion/i],
      ['CLI', { cliVersion: '9.9.9' }, /CLI.*provenance|cliVersion/i],
      [
        'MCP capability',
        { developerMcpCapabilityVersion: '9' },
        /MCP capability.*provenance|developerMcpCapabilityVersion/i,
      ],
      ['content hash', { contentHash: `sha256:${'f'.repeat(64)}` }, /content.*provenance/i],
    ];
    for (const [name, mismatch, error] of cases) {
      const { metadata, archivePath } = render(temporary(`mismatch-${name}`));
      expect(() => validateCopilotPluginArchive(archivePath, { ...metadata, ...mismatch })).toThrow(
        error,
      );
    }
  });
});
