import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTarget, RenderedProductSkillFileV1 } from '@noodle-borg/agent-kit';
import type { AppPackageArtifactV1 } from '@noodle-borg/compiler';
import type { AgentProductSkillCode, ProductSkillCompilation } from './agent-product-skill.js';
import {
  assertProductSkillPathsSafe,
  createProductSkillState,
  inspectProductSkillStateFiles,
  type ProductSkillState,
  readProductSkillState,
  unexpectedProductSkillPaths,
} from './agent-product-skill-state.js';

export interface ProductSkillDoctorCheck {
  readonly name: string;
  readonly level: 'PASS' | 'WARN' | 'FAIL';
  readonly message: string;
  readonly code?: AgentProductSkillCode;
}

export function doctorProjectProductSkill(input: {
  readonly project: string;
  readonly targets: readonly AgentTarget[];
  readonly compilation: ProductSkillCompilation;
}): readonly ProductSkillDoctorCheck[] {
  const compilation = input.compilation;
  if (compilation.kind === 'error') {
    return [
      {
        name: 'App product skill compilation',
        level: 'WARN',
        code: 'agent_skill_stale',
        message: compilation.message,
      },
    ];
  }
  if (compilation.kind === 'absent' || compilation.kind === 'unguided') {
    return input.targets.flatMap((target) => orphanedDoctorCheck(input.project, target));
  }
  return input.targets.map((target) =>
    inspectTarget({
      project: input.project,
      target,
      artifact: compilation.artifact,
      files: compilation.bundle.files.filter((file) => file.target === target),
      rendererVersion: compilation.bundle.rendererVersion,
      bundleSha256: compilation.bundle.bundleSha256,
      skillSlug: compilation.skillSlug,
    }),
  );
}

function inspectTarget(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly artifact: AppPackageArtifactV1;
  readonly files: readonly RenderedProductSkillFileV1[];
  readonly rendererVersion: string;
  readonly bundleSha256: string;
  readonly skillSlug: string;
}): ProductSkillDoctorCheck {
  const name = `${displayName(input.target)} app product skill`;
  if (input.files.length !== 2) {
    return {
      name,
      level: 'FAIL',
      code: 'agent_skill_stale',
      message: 'App Package renderer returned an incomplete target',
    };
  }
  try {
    assertProductSkillPathsSafe({
      project: input.project,
      target: input.target,
      paths: input.files.map((file) => file.path),
    });
    const read = readProductSkillState(input.project, input.target);
    if (read.kind === 'invalid') {
      return {
        name,
        level: 'FAIL',
        code: 'agent_skill_invalid_state',
        message: 'ownership record is malformed; preserve local files and review it',
      };
    }
    if (read.kind === 'absent') {
      const extras = unexpectedProductSkillPaths({
        project: input.project,
        target: input.target,
        skillSlug: input.skillSlug,
        expectedPaths: input.files.map((file) => file.path),
      });
      const exact =
        extras.length === 0 &&
        input.files.every((file) => {
          const path = join(input.project, file.path);
          return !existsSync(path) || readFileSync(path, 'utf8') === file.content;
        });
      return {
        name,
        level: 'WARN',
        code: exact ? 'agent_skill_stale' : 'agent_skill_modified',
        message: exact
          ? 'app product skill is not installed; run noodle agents setup, then --write'
          : 'unowned app skill files collide; review them before installation',
      };
    }
    const state = read.state;
    assertProductSkillPathsSafe({
      project: input.project,
      target: input.target,
      paths: state.files.map((file) => file.path),
    });
    const extras = unexpectedProductSkillPaths({
      project: input.project,
      target: input.target,
      skillSlug: state.app.skillSlug,
      expectedPaths: state.files.map((file) => file.path),
    });
    const disk = inspectProductSkillStateFiles(input.project, state);
    if (extras.length > 0 || disk.modified) {
      return {
        name,
        level: 'WARN',
        code: 'agent_skill_modified',
        message: 'generated app skill files were modified; local changes were preserved',
      };
    }
    if (disk.missing) {
      return {
        name,
        level: 'WARN',
        code: 'agent_skill_stale',
        message:
          'generated app skill files are missing; preview noodle agents setup before --write',
      };
    }
    if (read.migrationRequired) {
      return {
        name,
        level: 'WARN',
        code: 'agent_skill_stale',
        message:
          'ownership record schema is outdated; preview explicit app-skill regeneration before migration',
      };
    }
    const expected = createProductSkillState({
      target: input.target,
      artifact: input.artifact,
      bundle: {
        schemaVersion: 1,
        rendererVersion: input.rendererVersion,
        bundleSha256: input.bundleSha256,
      },
      files: input.files,
    });
    if (!sameState(state, expected)) {
      return {
        name,
        level: 'WARN',
        code: 'agent_skill_stale',
        message:
          'source, MCP surface, or renderer changed; preview noodle agents setup before --write',
      };
    }
    return { name, level: 'PASS', message: 'current' };
  } catch (cause) {
    return {
      name,
      level: 'FAIL',
      code: 'agent_skill_invalid_state',
      message: `unsafe app skill state: ${(cause as Error).message}`,
    };
  }
}

function orphanedDoctorCheck(
  project: string,
  target: AgentTarget,
): readonly ProductSkillDoctorCheck[] {
  try {
    const state = readProductSkillState(project, target);
    if (state.kind === 'absent') return [];
    return [
      {
        name: `${displayName(target)} app product skill`,
        level: state.kind === 'invalid' ? 'FAIL' : 'WARN',
        code: state.kind === 'invalid' ? 'agent_skill_invalid_state' : 'agent_skill_stale',
        message:
          state.kind === 'invalid'
            ? 'ownership record is malformed; preserve local files and review it'
            : 'installed app skill has no current TypeScript agent guide; local files were preserved',
      },
    ];
  } catch (cause) {
    return [
      {
        name: `${displayName(target)} app product skill`,
        level: 'FAIL',
        code: 'agent_skill_invalid_state',
        message: `unsafe app skill state: ${(cause as Error).message}`,
      },
    ];
  }
}

function sameState(left: ProductSkillState, right: ProductSkillState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayName(target: AgentTarget): string {
  return target === 'codex' ? 'Codex' : 'Claude Code';
}
