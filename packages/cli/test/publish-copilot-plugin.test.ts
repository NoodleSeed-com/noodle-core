import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPluginReleasePlan,
  PLUGIN_CONTENT_HASH_PLACEHOLDER,
  PLUGIN_SOURCE_SHA_PLACEHOLDER,
  PLUGIN_VERSION_PLACEHOLDER,
} from '../../../scripts/lib/plugin-release-plan.mjs';
import {
  renderCopilotReleaseProjection,
  renderMarketplaceReleaseProjection,
} from '../../../scripts/lib/plugin-release-projections.mjs';
import { publishCopilotPlugin } from '../../../scripts/publish-copilot-plugin.mjs';
import { renderReleaseCopilotPlugin } from '../../../scripts/render-copilot-plugin.mjs';

const roots: string[] = [];
const SOURCE_SHA = 'a'.repeat(40);
const SHARED = {
  agentKitVersion: '2.3.4',
  cliVersion: '5.6.7',
  developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
  developerMcpCapabilityVersion: '1',
};

function temporary(name: string) {
  const root = mkdtempSync(join(tmpdir(), `noodle-copilot-publish-${name}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configure(cwd: string) {
  git(cwd, ['config', 'user.name', 'Fixture']);
  git(cwd, ['config', 'user.email', 'fixture@example.com']);
}

function repository(name: string, seed = true) {
  const root = temporary(name);
  const remote = join(root, 'remote.git');
  const seedCheckout = join(root, 'seed');
  const checkout = join(root, 'checkout');
  git(root, ['init', '--bare', remote]);
  if (seed) {
    git(root, ['clone', remote, seedCheckout]);
    configure(seedCheckout);
    writeFileSync(join(seedCheckout, 'NOTICE'), 'repository-owned notice\n');
    mkdirSync(join(seedCheckout, 'bin'), { recursive: true });
    writeFileSync(join(seedCheckout, 'bin', 'obsolete.mjs'), 'obsolete\n');
    mkdirSync(join(seedCheckout, 'skills', 'obsolete'), { recursive: true });
    writeFileSync(join(seedCheckout, 'skills', 'obsolete', 'SKILL.md'), 'obsolete\n');
    git(seedCheckout, ['add', '.']);
    git(seedCheckout, ['commit', '-m', 'chore: seed Copilot repository']);
    git(seedCheckout, ['push', 'origin', 'HEAD:main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(root, ['clone', remote, checkout]);
  configure(checkout);
  return { root, remote, checkout };
}

function releasePlan(compatibility = SHARED) {
  const normalized = {
    ...compatibility,
    mode: 'release' as const,
    version: PLUGIN_VERSION_PLACEHOLDER,
    pluginContentHash: PLUGIN_CONTENT_HASH_PLACEHOLDER,
  };
  return createPluginReleasePlan({
    ...compatibility,
    projections: {
      pluginMarketplace: renderMarketplaceReleaseProjection(normalized),
      copilotPlugin: renderCopilotReleaseProjection({
        ...normalized,
        sourceSha: PLUGIN_SOURCE_SHA_PLACEHOLDER,
      }),
    },
  });
}

function archive(root: string, version = '2.3.4') {
  const agentKitTree = join(root, `agent-kit-${version}`);
  const stagingDirectory = join(root, `copilot-plugin-${version}`);
  const archivePath = join(root, `copilot-plugin-${version}.tgz`);
  mkdirSync(agentKitTree, { recursive: true });
  writeFileSync(join(agentKitTree, 'package.json'), `${JSON.stringify({ version })}\n`);
  const compatibility = {
    ...SHARED,
    agentKitVersion: version,
    cliVersion: version === '2.3.4' ? '5.6.7' : '5.6.8',
  };
  renderReleaseCopilotPlugin({
    agentKitTree,
    ...compatibility,
    releasePlan: releasePlan(compatibility),
    sourceSha: SOURCE_SHA,
    stagingDirectory,
    archivePath,
  });
  return { archivePath, stagingDirectory };
}

function publish(checkout: string, archivePath: string, releaseId = 'r42') {
  return publishCopilotPlugin({ archive: archivePath, checkout, releaseId, sourceSha: SOURCE_SHA });
}

function remoteMain(cwd: string, remote: string) {
  return git(cwd, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0];
}

function tarHeader(path: string, size: number) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function unsafeArchive(root: string, path: string) {
  const content = Buffer.from('unsafe');
  const archivePath = join(root, `unsafe-${path.replace(/[^a-z]/gi, '')}.tgz`);
  writeFileSync(
    archivePath,
    gzipSync(
      Buffer.concat([
        tarHeader(path, content.length),
        content,
        Buffer.alloc((512 - (content.length % 512)) % 512),
        Buffer.alloc(1024),
      ]),
      { mtime: 0 },
    ),
  );
  return archivePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Copilot plugin publisher', () => {
  it('publishes exactly the generated roots, preserves repository-owned files, and records provenance', () => {
    const repo = repository('initial');
    const candidate = archive(repo.root);
    const result = publish(repo.checkout, candidate.archivePath);

    expect(result.status).toBe('published');
    expect(readFileSync(join(repo.checkout, 'plugin.json'), 'utf8')).toContain('noodle-seed');
    expect(
      readFileSync(join(repo.checkout, 'skills', 'noodle-seed', 'SKILL.md'), 'utf8'),
    ).toContain('noodle-skill');
    expect(() => readFileSync(join(repo.checkout, 'bin', 'obsolete.mjs'))).toThrow();
    expect(() => readFileSync(join(repo.checkout, 'skills', 'obsolete', 'SKILL.md'))).toThrow();
    expect(readFileSync(join(repo.checkout, 'NOTICE'), 'utf8')).toContain('repository-owned');
    expect(git(repo.checkout, ['show', '-s', '--format=%an|%ae|%s'])).toBe(
      'noodle-system-release|release@noodleseed.com|noodle-system-release r42',
    );
    expect(git(repo.checkout, ['show', '-s', '--format=%B'])).toContain(SOURCE_SHA);
    expect(remoteMain(repo.root, repo.remote)).toBe(result.commitSha);
  });

  it('publishes an empty repository, replays unchanged content, and advances new content', () => {
    const repo = repository('lifecycle', false);
    const first = archive(repo.root);
    expect(publish(repo.checkout, first.archivePath).status).toBe('published');
    expect(publish(repo.checkout, first.archivePath).status).toBe('unchanged');

    const second = archive(repo.root, '2.3.5');
    expect(publish(repo.checkout, second.archivePath, 'r43').status).toBe('published');
    expect(git(repo.checkout, ['log', '--format=%s'])).toContain('noodle-system-release r43');
  });

  it('rejects a stale checkout without changing the remote', () => {
    const repo = repository('stale');
    const competitor = join(repo.root, 'competitor');
    git(repo.root, ['clone', repo.remote, competitor]);
    configure(competitor);
    writeFileSync(join(competitor, 'NOTICE'), 'concurrent update\n');
    git(competitor, ['add', 'NOTICE']);
    git(competitor, ['commit', '-m', 'chore: concurrent update']);
    git(competitor, ['push', 'origin', 'HEAD:main']);
    const expectedHead = remoteMain(repo.root, repo.remote);

    expect(() => publish(repo.checkout, archive(repo.root).archivePath)).toThrow(
      /remote head moved|not current/i,
    );
    expect(remoteMain(repo.root, repo.remote)).toBe(expectedHead);
  });

  it('rejects an unapproved pre-staged path without changing the remote or index', () => {
    const repo = repository('pre-staged');
    const before = remoteMain(repo.root, repo.remote);
    writeFileSync(join(repo.checkout, 'NOTICE'), 'staged repository-owned change\n');
    git(repo.checkout, ['add', 'NOTICE']);

    expect(() => publish(repo.checkout, archive(repo.root).archivePath)).toThrow(/staged changes/i);
    expect(remoteMain(repo.root, repo.remote)).toBe(before);
    expect(git(repo.checkout, ['diff', '--cached', '--name-only'])).toBe('NOTICE');
  });

  it('rejects traversal and extra-root archives before remote mutation', () => {
    const repo = repository('unsafe');
    const before = remoteMain(repo.root, repo.remote);
    expect(() => publish(repo.checkout, unsafeArchive(repo.root, '../outside'))).toThrow(
      /unsafe path|traversal/i,
    );
    expect(remoteMain(repo.root, repo.remote)).toBe(before);

    const candidate = archive(repo.root);
    writeFileSync(join(candidate.stagingDirectory, 'SECURITY.md'), 'not generated\n');
    execFileSync('tar', ['-czf', candidate.archivePath, '-C', candidate.stagingDirectory, '.']);
    expect(() => publish(repo.checkout, candidate.archivePath)).toThrow(/unapproved top-level/i);
    expect(remoteMain(repo.root, repo.remote)).toBe(before);
  });

  it('never force-pushes when the remote moves immediately before publication', () => {
    const repo = repository('fast-forward');
    const competitor = join(repo.root, 'competitor');
    git(repo.root, ['clone', repo.remote, competitor]);
    configure(competitor);
    const hook = join(repo.checkout, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf 'concurrent update\\n' > '${join(competitor, 'NOTICE')}'\ngit -C '${competitor}' add NOTICE\ngit -C '${competitor}' commit -m 'chore: concurrent push'\ngit -C '${competitor}' push origin HEAD:main\n`,
    );
    chmodSync(hook, 0o755);

    expect(() => publish(repo.checkout, archive(repo.root).archivePath)).toThrow(
      /not a fast-forward/i,
    );
    expect(git(repo.remote, ['show', '--format=', 'main:NOTICE'])).toContain('concurrent update');
    expect(() => git(repo.remote, ['show', '--format=', 'main:plugin.json'])).toThrow();
  });

  it('uses the shared repository-scoped App and exact archive in System Release', () => {
    const script = readFileSync(
      new URL('../../../scripts/publish-copilot-plugin.mjs', import.meta.url),
      'utf8',
    );
    const workflow = readFileSync(
      new URL('../../../.github/workflows/system-release.yml', import.meta.url),
      'utf8',
    );

    expect(script).not.toMatch(/push[^\n]*(?:--force|-f\b)/);
    expect(workflow).toContain('PLUGIN_PUBLISHER_APP_ID');
    expect(workflow).toContain('PLUGIN_PUBLISHER_PRIVATE_KEY');
    expect(workflow).toMatch(/repositories:\s*\|\s*\n\s+plugins\s*\n\s+copilot-plugin/);
    expect(workflow).toContain('node scripts/publish-copilot-plugin.mjs');
    expect(workflow).toContain('--archive copilot-plugin.tgz');
  });
});
