import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExportOpenAiPlugin } from '@noodle-borg/plugin-distribution/command';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { compileLocalInput } from '../src/local-compile.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

const SERVER = join(import.meta.dirname, 'fixtures', 'restaurant-pickup', 'src', 'server.ts');
const ESCAPING_ASSET_SERVER = join(
  import.meta.dirname,
  'fixtures',
  'openai-asset-escape',
  'server.ts',
);
const REGISTERED_APP_ID = `plugin_asdk_app_${'2'.repeat(32)}`;

let directory: string;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'noodle-openai-export-'));
  home = mkdtempSync(join(tmpdir(), 'noodle-openai-export-home-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function lastEnvelope<T>(): ReturnType<typeof assertJsonEnvelope<T>> {
  return assertJsonEnvelope<T>(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
}

function zipPaths(bytes: Uint8Array): readonly string[] {
  const buffer = Buffer.from(bytes);
  const paths: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    paths.push(buffer.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return paths;
}

describe('noodle export plugin openai', () => {
  it('compiles server.ts and writes a byte-stable submission ZIP', async () => {
    const first = join(directory, 'restaurant-openai-1.zip');
    const second = join(directory, 'restaurant-openai-2.zip');
    writeFileSync(first, 'replace this existing archive');
    const common = [
      'plugin',
      'openai',
      SERVER,
      '--state',
      'submission',
      '--mcp-url',
      'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
      '--category',
      'Food & Drink',
      '--json',
    ] as const;

    expect(await run(['export', ...common, '--output', first], {}, home)).toBe(0);
    expect(readFileSync(first)).not.toEqual(Buffer.from('replace this existing archive'));
    const envelope = lastEnvelope<{
      target: string;
      state: string;
      app: { name: string; version: string };
      output: string;
      uploadArtifacts: {
        instructions: string;
        submissionJson: string;
        skillZip: string;
      };
      treeSha256: string;
      archiveSha256: string;
      byteLength: number;
      files: readonly { path: string; sha256: string; byteLength: number }[];
    }>();
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected successful export');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(envelope.data).toMatchObject({
      target: 'openai',
      state: 'submission',
      app: { name: 'restaurant-pickup', version: '1.0.0' },
      output: first,
      uploadArtifacts: {
        instructions: 'submission/README.md',
        submissionJson: 'submission/chatgpt-app-submission.json',
        skillZip: 'submission/restaurant-pickup-skill.zip',
      },
      treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      byteLength: expect.any(Number),
    });
    expect(envelope.data.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        '.codex-plugin/plugin.json',
        '.mcp.json',
        'skills/restaurant-pickup/SKILL.md',
        'submission/README.md',
        'submission/chatgpt-app-submission.json',
        'submission/restaurant-pickup-skill.zip',
      ]),
    );

    logSpy.mockClear();
    expect(await run(['export', ...common, '--output', second], {}, home)).toBe(0);
    expect(readFileSync(first)).toEqual(readFileSync(second));
    expect(zipPaths(readFileSync(first))).toEqual(
      expect.arrayContaining([
        '.codex-plugin/plugin.json',
        '.mcp.json',
        'skills/restaurant-pickup/SKILL.md',
        'submission/README.md',
        'submission/chatgpt-app-submission.json',
        'submission/restaurant-pickup-skill.zip',
      ]),
    );
  }, 30_000);

  it('tells a human to extract the submission kit and upload its two portal artifacts', async () => {
    const output = join(directory, 'restaurant-openai.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          SERVER,
          '--state',
          'submission',
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--category',
          'Food & Drink',
          '--output',
          output,
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(logSpy.mock.calls.map(([message]) => message)).toEqual([
      `Wrote OpenAI submission review kit to ${output}`,
      'Extract the outer ZIP before uploading either portal artifact.',
      'Submission JSON: submission/chatgpt-app-submission.json',
      'Skill ZIP: submission/restaurant-pickup-skill.zip',
      'Instructions: submission/README.md',
      expect.stringMatching(/^Archive SHA-256: [a-f0-9]{64}$/),
    ]);
  }, 30_000);

  it('writes the separate local repo-marketplace projection when given a registered app ID', async () => {
    const output = join(directory, 'restaurant-openai-local.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          SERVER,
          '--state',
          'local',
          '--mcp-url',
          'http://127.0.0.1:8787/mcp',
          '--category',
          'Food & Drink',
          '--registered-app-id',
          REGISTERED_APP_ID,
          '--output',
          output,
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(zipPaths(readFileSync(output))).toEqual(
      expect.arrayContaining([
        '.agents/plugins/marketplace.json',
        'plugins/restaurant-pickup/.app.json',
        'plugins/restaurant-pickup/.codex-plugin/plugin.json',
        'plugins/restaurant-pickup/.mcp.json',
      ]),
    );
    const envelope = lastEnvelope<{ state: string; output: string }>();
    expect(envelope.ok).toBe(true);
    if (envelope.ok)
      expect(envelope.data).toEqual(expect.objectContaining({ state: 'local', output }));
  }, 30_000);

  it('rejects the non-canonical endpoint flag without writing output', async () => {
    const output = join(directory, 'legacy-endpoint.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          SERVER,
          '--state',
          'submission',
          '--endpoint',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--category',
          'Food & Drink',
          '--output',
          output,
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(2);
    expect(existsSync(output)).toBe(false);
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected usage failure');
    expect(envelope.error.code).toBe('usage_error');
  });

  it('returns the JSON routing envelope when the plugin target is missing', async () => {
    expect(await run(['export', 'plugin', '--json'], {}, home)).toBe(2);
    expect(errorSpy).not.toHaveBeenCalled();
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected usage failure');
    expect(envelope.error.code).toBe('unsupported_plugin_target');
  });

  it('reports an invalid archive output path through the JSON failure contract', async () => {
    const output = join(directory, 'missing', 'restaurant-openai.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          SERVER,
          '--state',
          'submission',
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--category',
          'Food & Drink',
          '--output',
          output,
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected archive write failure');
    expect(envelope.error.code).toBe('openai_package_write_failed');
  }, 30_000);

  it('preserves an existing archive when the atomic writer fails', async () => {
    const output = join(directory, 'existing.zip');
    const original = Buffer.from('existing archive bytes');
    writeFileSync(output, original);
    expect(
      await runExportOpenAiPlugin(
        [
          SERVER,
          '--state',
          'submission',
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--category',
          'Food & Drink',
          '--output',
          output,
          '--json',
        ],
        compileLocalInput,
        () => undefined,
        () => {
          throw new Error('simulated write failure');
        },
      ),
    ).toBe(1);
    expect(readFileSync(output)).toEqual(original);
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected archive write failure');
    expect(envelope.error.code).toBe('openai_package_write_failed');
  }, 30_000);

  it('fails without writing partial output when target input is invalid', async () => {
    const output = join(directory, 'invalid.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          SERVER,
          '--state',
          'local',
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--category',
          'Food & Drink',
          '--registered-app-id',
          'wrong-id',
          '--output',
          output,
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected export failure');
    expect(envelope.error.code).toBe('openai_package_invalid');
    expect(envelope.error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'openai_local_registered_app_invalid' }),
      ]),
    );
  }, 30_000);

  it('rejects a distribution-only asset that escapes the server root without writing output', async () => {
    const output = join(directory, 'escaped-asset.zip');
    expect(
      await run(
        [
          'export',
          'plugin',
          'openai',
          ESCAPING_ASSET_SERVER,
          '--state',
          'local',
          '--mcp-url',
          'http://127.0.0.1:8787/mcp',
          '--category',
          'Productivity',
          '--registered-app-id',
          REGISTERED_APP_ID,
          '--output',
          output,
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    const envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected export failure');
    expect(envelope.error.code).toBe('openai_package_assets_invalid');
  }, 30_000);
});
