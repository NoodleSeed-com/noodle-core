import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The generators are build scripts (.mjs); import their pure extractor/renderer for in-process checks.
import { extractExamples, renderExamplesModule } from '../../../scripts/gen-agent-kit-examples.mjs';
import { extractSurface, renderSurfaceModule } from '../../../scripts/gen-agent-skill-data.mjs';
import { COMMAND_GROUPS } from '../src/curated/command-groups.js';
import { ERROR_FIXES } from '../src/curated/error-fixes.js';
import { HOOK_NOTES } from '../src/curated/hook-notes.js';
import {
  CLI_COMMANDS,
  COMPILE_ERROR_CODES,
  REACT_HOOKS,
  SDK_EXPORTS,
} from '../src/generated/surface.js';
import { skillRouterBody } from '../src/skill-content.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'gen-agent-skill-data.mjs');
const examplesScript = join(repoRoot, 'scripts', 'gen-agent-kit-examples.mjs');
const surfacePath = join(import.meta.dirname, '..', 'src', 'generated', 'surface.ts');
const examplesPath = join(import.meta.dirname, '..', 'src', 'generated', 'example-files.ts');

describe('agent-kit skill surface drift gate', () => {
  it('reports the committed surface module as up to date (`skills:gen --check`)', () => {
    const result = spawnSync(process.execPath, [script, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('up to date');
  });

  it('matches the committed surface byte-for-byte with a fresh extraction', () => {
    const regenerated = renderSurfaceModule(extractSurface());
    expect(readFileSync(surfacePath, 'utf8')).toBe(regenerated);
  });

  it('reports the committed bundled examples as up to date (`skills:examples:gen --check`)', () => {
    const result = spawnSync(process.execPath, [examplesScript, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('up to date');
  });

  it('matches the committed example-files module byte-for-byte with a fresh extraction', () => {
    const regenerated = renderExamplesModule(extractExamples());
    expect(readFileSync(examplesPath, 'utf8')).toBe(regenerated);
  });

  it('extracts the live CLI/SDK/compiler surface into the committed arrays', () => {
    const surface = extractSurface();
    expect(surface.commands).toEqual([...CLI_COMMANDS]);
    expect(surface.sdkExports).toEqual([...SDK_EXPORTS]);
    expect(surface.errorCodes).toEqual([...COMPILE_ERROR_CODES]);
    expect(surface.reactHooks).toEqual([...REACT_HOOKS]);
  });

  it('captures the authoritative names (sanity anchors, not a hand-maintained allowlist)', () => {
    for (const cmd of ['validate', 'test', 'dev', 'deploy', 'secrets', 'agents']) {
      expect(CLI_COMMANDS).toContain(cmd);
    }
    expect(CLI_COMMANDS).not.toContain('plugin-mcp');
    for (const sym of ['server', 'tool', 'connector', 'resource', 'customerAuth', 'z']) {
      expect(SDK_EXPORTS).toContain(sym);
    }
    for (const hook of ['useCallTool', 'useOpenExternal', 'useSendFollowUpMessage', 'useLayout']) {
      expect(REACT_HOOKS).toContain(hook);
    }
    // Regression guard: the old hand-written skill listed `ui`, which is not a real export.
    expect(SDK_EXPORTS).not.toContain('ui');
    for (const removed of ['toolForWidget', 'toolWithWidget', 'widget']) {
      expect(SDK_EXPORTS).not.toContain(removed);
    }
  });

  it('has a curated fix for every compile-error code and no orphan fixes', () => {
    const fixKeys = Object.keys(ERROR_FIXES).sort();
    const codes = [...COMPILE_ERROR_CODES].sort();
    expect(fixKeys).toEqual(codes);
    for (const code of COMPILE_ERROR_CODES) {
      expect(ERROR_FIXES[code]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('has a curated note for every React hook and no orphan notes', () => {
    const noteKeys = Object.keys(HOOK_NOTES).sort();
    const hooks = [...REACT_HOOKS].sort();
    expect(noteKeys).toEqual(hooks);
    for (const hook of REACT_HOOKS) {
      expect(HOOK_NOTES[hook]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('has a curated group + summary for every CLI command and no orphan entries', () => {
    const groupKeys = Object.keys(COMMAND_GROUPS).sort();
    const commands = [...CLI_COMMANDS].sort();
    expect(groupKeys).toEqual(commands);
    for (const cmd of CLI_COMMANDS) {
      expect(COMMAND_GROUPS[cmd]?.group?.length ?? 0).toBeGreaterThan(0);
      expect(COMMAND_GROUPS[cmd]?.summary?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('keeps installed-plugin CLI ownership explicit in both host skills', () => {
    for (const host of ['codex', 'claude'] as const) {
      const skill = skillRouterBody(host);
      expect(skill).toContain('supported `noodle-readiness` tools');
      expect(skill).toContain('public `noodle ...` command');
      expect(skill).toContain('you write and test the application source');
      expect(skill).not.toMatch(/noodle-plugin(?:-cursor)?\.mjs|<managed-launcher>|plugin-cache/i);
    }
  });
});
