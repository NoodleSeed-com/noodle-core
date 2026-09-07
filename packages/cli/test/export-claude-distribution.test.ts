import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExportAnthropicConnector,
  runExportClaudePlugin,
} from '@noodle-borg/plugin-distribution/command';
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

let directory: string;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'noodle-claude-export-'));
  home = mkdtempSync(join(tmpdir(), 'noodle-claude-export-home-'));
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

function zipEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const buffer = Buffer.from(bytes);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const path = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const contentOffset = offset + 30 + nameLength + extraLength;
    entries.set(path, buffer.subarray(contentOffset, contentOffset + compressedSize));
    offset = contentOffset + compressedSize;
  }
  return entries;
}

describe('Claude distribution exports', () => {
  it('exports an installable Claude Code plugin repository deterministically', async () => {
    const first = join(directory, 'restaurant-claude-1.zip');
    const second = join(directory, 'restaurant-claude-2.zip');
    const common = [
      'export',
      'plugin',
      'claude',
      SERVER,
      '--mcp-url',
      'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
      '--json',
    ] as const;

    expect(await run([...common, '--output', first], {}, home)).toBe(0);
    const envelope = lastEnvelope<{
      target: string;
      output: string;
      archiveSha256: string;
      files: readonly { path: string }[];
    }>();
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected successful plugin export');
    expect(envelope.data).toMatchObject({
      target: 'claude',
      output: first,
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(envelope.data.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'README.md',
        'skills/restaurant-pickup/SKILL.md',
      ]),
    );

    logSpy.mockClear();
    expect(await run([...common, '--output', second], {}, home)).toBe(0);
    expect(readFileSync(first)).toEqual(readFileSync(second));
  }, 30_000);

  it('exports a separate Anthropic Connector Directory dossier with authored widget evidence', async () => {
    const output = join(directory, 'restaurant-connector.zip');
    const exitCode = await run(
      [
        'export',
        'connector',
        'claude',
        SERVER,
        '--mcp-url',
        'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
        '--auth',
        'none',
        '--category',
        'Food & Drink',
        '--category',
        'Productivity',
        '--output',
        output,
        '--json',
      ],
      {},
      home,
    );
    expect(exitCode).toBe(0);

    const envelope = lastEnvelope<{ app: { name: string; version: string } }>();
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected successful connector export');
    expect(envelope.data.app).toEqual({ name: 'restaurant-pickup', version: '1.0.0' });

    const entries = zipEntries(readFileSync(output));
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        'assets/screenshot-01.png',
        'assets/screenshot-02.png',
        'assets/screenshot-03.png',
        'submission/README.md',
        'submission/anthropic-connector.json',
      ]),
    );
    expect([...entries.keys()].some((path) => path.startsWith('.claude-plugin/'))).toBe(false);
    const dossierBytes = entries.get('submission/anthropic-connector.json');
    if (dossierBytes === undefined) throw new Error('missing connector dossier');
    const dossier = JSON.parse(new TextDecoder().decode(dossierBytes)) as {
      portalUploadable: boolean;
      listing: { categories: readonly string[] };
      allowedLinks: { candidates: readonly string[] };
      screenshots: readonly { alt: string; prompt: string; width: number }[];
    };
    expect(dossier).toMatchObject({
      portalUploadable: false,
      listing: { categories: ['Food & Drink', 'Productivity'] },
      allowedLinks: {
        candidates: ['https://example.com', 'https://orders.example.com'],
      },
    });
    expect(dossier.screenshots).toHaveLength(3);
    expect(
      dossier.screenshots.every(({ prompt, width }) => prompt.length > 0 && width >= 1000),
    ).toBe(true);
    expect(dossier.screenshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alt: 'Restaurant Pickup MCP App checkout handoff',
          prompt: "Review Asha's falafel pickup order before checkout.",
        }),
      ]),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  }, 30_000);

  it('does not write partial output when connector options are invalid', async () => {
    const output = join(directory, 'invalid-connector.zip');
    expect(
      await run(
        [
          'export',
          'connector',
          'claude',
          SERVER,
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--auth',
          'oauth-dcr',
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
    if (!envelope.ok) expect(envelope.error.code).toBe('usage_error');
  }, 30_000);

  it('returns stable compile and missing-package failures without invoking the writer', async () => {
    const output = join(directory, 'not-written.zip');
    const writer = vi.fn();
    const common = [
      SERVER,
      '--mcp-url',
      'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
      '--auth',
      'none',
      '--category',
      'Food & Drink',
      '--output',
      output,
      '--json',
    ] as const;

    expect(
      await runExportAnthropicConnector(
        common,
        async () => ({
          ok: false,
          errors: [{ code: 'fixture_compile_error', path: 'server', message: 'fixture failure' }],
        }),
        () => undefined,
        writer,
      ),
    ).toBe(1);
    let envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('claude_connector_compile_failed');

    logSpy.mockClear();
    expect(
      await runExportClaudePlugin(
        [
          SERVER,
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--output',
          output,
          '--json',
        ],
        async () => ({ ok: true, rootDir: directory, compiled: {} }),
        () => undefined,
        writer,
      ),
    ).toBe(1);
    envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('claude_plugin_unavailable');
    expect(writer).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it('rejects escaped assets and preserves existing output when the writer fails', async () => {
    const escapedOutput = join(directory, 'escaped.zip');
    expect(
      await runExportClaudePlugin(
        [
          ESCAPING_ASSET_SERVER,
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/escaped/mcp',
          '--output',
          escapedOutput,
          '--json',
        ],
        compileLocalInput,
        () => undefined,
      ),
    ).toBe(1);
    let envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('claude_plugin_assets_invalid');
    expect(existsSync(escapedOutput)).toBe(false);

    logSpy.mockClear();
    const existingOutput = join(directory, 'existing.zip');
    const existingBytes = Buffer.from('existing archive bytes');
    writeFileSync(existingOutput, existingBytes);
    expect(
      await runExportClaudePlugin(
        [
          SERVER,
          '--mcp-url',
          'https://demo.cloud.noodleseed.dev/restaurant-pickup/mcp',
          '--output',
          existingOutput,
          '--json',
        ],
        compileLocalInput,
        () => undefined,
        () => {
          throw new Error('simulated write failure');
        },
      ),
    ).toBe(1);
    envelope = lastEnvelope();
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe('claude_plugin_write_failed');
    expect(readFileSync(existingOutput)).toEqual(existingBytes);
  }, 30_000);
});
