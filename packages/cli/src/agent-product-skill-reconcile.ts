import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentTarget,
  RenderedProductSkillBundleV1,
  RenderedProductSkillFileV1,
} from '@noodle-borg/agent-kit';
import type { AppPackageArtifactV1 } from '@noodle-borg/compiler';
import type {
  AgentProductSkillIssue,
  ProductSkillFileAction,
  ProductSkillSetupReport,
  ProductSkillTargetReport,
} from './agent-product-skill.js';
import {
  assertProductSkillPathsSafe,
  createProductSkillState,
  inspectProductSkillStateFiles,
  type ProductSkillState,
  productSkillStatePath,
  readProductSkillState,
  removeProductSkillFiles,
  removeProductSkillState,
  unexpectedProductSkillPaths,
  writeProductSkillState,
} from './agent-product-skill-state.js';
import { atomicWriteProjectFile } from './agent-skills-state.js';

export interface ProductSkillReconcileInput {
  readonly project: string;
  readonly target: AgentTarget;
  readonly write: boolean;
  readonly regenerateAppSkill: boolean;
  readonly replaceModifiedAppSkill: boolean;
  readonly artifact: AppPackageArtifactV1;
  readonly bundle: RenderedProductSkillBundleV1;
  readonly skillSlug: string;
}

export function reconcileProductSkillTarget(
  input: ProductSkillReconcileInput,
): ProductSkillTargetReport {
  const files = targetFiles(input.bundle, input.target);
  const statePath = productSkillStatePath(input.target);
  try {
    assertProductSkillPathsSafe({
      project: input.project,
      target: input.target,
      paths: files.map((file) => file.path),
    });
    const read = readProductSkillState(input.project, input.target);
    if (read.kind === 'invalid') {
      return invalidTarget(input.target, statePath, files, 'ownership record is malformed');
    }
    if (read.kind === 'absent') return adoptOrCreateTarget(input, files, statePath);

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
    if (extras.length > 0) {
      return blockedTarget(input.target, statePath, files, `unowned file collision: ${extras[0]}`);
    }

    const disk = inspectProductSkillStateFiles(input.project, state);
    const replaceModified = input.regenerateAppSkill && input.replaceModifiedAppSkill;
    if (disk.modified && !replaceModified) {
      return blockedTarget(
        input.target,
        statePath,
        files,
        'generated files differ from their recorded hashes',
        { recovery: 'replace_modified_app_skill' },
      );
    }

    const oldPaths = new Set(state.files.map((file) => file.path));
    const layoutChanged =
      state.app.name !== input.artifact.app.name ||
      state.app.skillSlug !== input.skillSlug ||
      !samePaths(state.files, files);
    if (layoutChanged) {
      const nextExtras = unexpectedProductSkillPaths({
        project: input.project,
        target: input.target,
        skillSlug: input.skillSlug,
        expectedPaths: files.map((file) => file.path),
      });
      if (nextExtras.length > 0) {
        return blockedTarget(
          input.target,
          statePath,
          files,
          `unowned destination collision: ${nextExtras[0]}`,
        );
      }
      const collision = files.find((file) => {
        const path = join(input.project, file.path);
        return (
          !oldPaths.has(file.path) &&
          existsSync(path) &&
          readFileSync(path, 'utf8') !== file.content
        );
      });
      if (collision !== undefined) {
        return blockedTarget(
          input.target,
          statePath,
          files,
          `unowned destination collision: ${collision.path}`,
        );
      }
    }

    const desiredPaths = new Set(files.map((file) => file.path));
    const actions: ProductSkillFileAction[] = state.files
      .filter((file) => !desiredPaths.has(file.path))
      .map((file) => ({ path: file.path, action: 'removed' }));
    actions.push(
      ...files.map((file): ProductSkillFileAction => {
        const path = join(input.project, file.path);
        if (!existsSync(path)) return { path: file.path, action: 'created' };
        return readFileSync(path, 'utf8') === file.content
          ? { path: file.path, action: 'unchanged' }
          : { path: file.path, action: 'updated' };
      }),
    );
    const nextState = createProductSkillState({
      target: input.target,
      artifact: input.artifact,
      bundle: input.bundle,
      files,
    });
    const changed =
      read.migrationRequired ||
      actions.some((action) => action.action !== 'unchanged') ||
      !sameState(state, nextState);
    const apply = changed && input.write && input.regenerateAppSkill;
    if (apply) writeTarget(input.project, input.target, files, actions, nextState);
    return {
      target: input.target,
      status:
        changed && read.migrationRequired && !layoutChanged && !disk.modified
          ? 'stale'
          : changed
            ? 'updated'
            : 'unchanged',
      statePath,
      applied: apply,
      requiresRegeneration: changed,
      stateAction: read.migrationRequired ? 'migrated' : changed ? 'updated' : 'unchanged',
      files: actions,
    };
  } catch (cause) {
    return invalidTarget(input.target, statePath, files, errorMessage(cause));
  }
}

export function orphanedProductSkillSetupReport(input: {
  readonly project: string;
  readonly targets: readonly AgentTarget[];
  readonly write: boolean;
  readonly regenerateAppSkill?: boolean;
  readonly replaceModifiedAppSkill?: boolean;
}): ProductSkillSetupReport | undefined {
  const reports: ProductSkillTargetReport[] = [];
  let app: ProductSkillState['app'] | undefined;
  for (const target of input.targets) {
    try {
      const read = readProductSkillState(input.project, target);
      if (read.kind === 'absent') continue;
      if (read.kind === 'invalid') {
        reports.push(
          invalidTarget(target, productSkillStatePath(target), [], 'ownership record is malformed'),
        );
        continue;
      }
      const state = read.state;
      app ??= state.app;
      assertProductSkillPathsSafe({
        project: input.project,
        target,
        paths: state.files.map((file) => file.path),
      });
      const extras = unexpectedProductSkillPaths({
        project: input.project,
        target,
        skillSlug: state.app.skillSlug,
        expectedPaths: state.files.map((file) => file.path),
      });
      if (extras.length > 0) {
        reports.push(
          blockedTarget(
            target,
            productSkillStatePath(target),
            [],
            `unowned file collision: ${extras[0]}`,
          ),
        );
        continue;
      }

      const disk = inspectProductSkillStateFiles(input.project, state);
      const replaceModified =
        input.regenerateAppSkill === true && input.replaceModifiedAppSkill === true;
      if (disk.modified && !replaceModified) {
        reports.push(
          blockedTarget(
            target,
            productSkillStatePath(target),
            [],
            'generated files differ from their recorded hashes',
            { recovery: 'replace_modified_app_skill' },
          ),
        );
        continue;
      }
      const actions = state.files.map(
        (file): ProductSkillFileAction => ({
          path: file.path,
          action: existsSync(join(input.project, file.path)) ? 'removed' : 'unchanged',
        }),
      );
      const apply = input.write && input.regenerateAppSkill === true;
      if (apply) {
        removeProductSkillFiles({
          project: input.project,
          target,
          paths: state.files.map((file) => file.path),
        });
        removeProductSkillState(input.project, target);
      }
      reports.push({
        target,
        status: 'removed',
        statePath: productSkillStatePath(target),
        applied: apply,
        requiresRegeneration: true,
        stateAction: 'removed',
        files: actions,
      });
    } catch (cause) {
      reports.push(invalidTarget(target, productSkillStatePath(target), [], errorMessage(cause)));
    }
  }
  if (reports.length === 0) return undefined;
  const issues = reports.flatMap((target) =>
    target.issue === undefined ? [] : [{ ...target.issue, target: target.target }],
  );
  return {
    ok: issues.length === 0,
    ...(app === undefined ? {} : { app }),
    targets: reports,
    issues,
  };
}

function adoptOrCreateTarget(
  input: ProductSkillReconcileInput,
  files: readonly RenderedProductSkillFileV1[],
  statePath: string,
): ProductSkillTargetReport {
  const extras = unexpectedProductSkillPaths({
    project: input.project,
    target: input.target,
    skillSlug: input.skillSlug,
    expectedPaths: files.map((file) => file.path),
  });
  const actions = files.map((file): ProductSkillFileAction => {
    const path = join(input.project, file.path);
    if (!existsSync(path)) return { path: file.path, action: 'created' };
    return readFileSync(path, 'utf8') === file.content
      ? { path: file.path, action: 'unchanged' }
      : { path: file.path, action: 'skipped', reason: 'unowned file collision' };
  });
  if (extras.length > 0 || actions.some((action) => action.action === 'skipped')) {
    return blockedTarget(
      input.target,
      statePath,
      files,
      `unowned file collision${extras[0] === undefined ? '' : `: ${extras[0]}`}`,
    );
  }
  const state = createProductSkillState({
    target: input.target,
    artifact: input.artifact,
    bundle: input.bundle,
    files,
  });
  if (input.write) writeTarget(input.project, input.target, files, actions, state);
  return {
    target: input.target,
    status: actions.some((action) => action.action === 'created') ? 'created' : 'unchanged',
    statePath,
    applied: input.write,
    requiresRegeneration: false,
    stateAction: 'created',
    files: actions,
  };
}

function writeTarget(
  project: string,
  target: AgentTarget,
  files: readonly RenderedProductSkillFileV1[],
  actions: readonly ProductSkillFileAction[],
  state: ProductSkillState,
): void {
  for (const file of files) {
    const action = actions.find((candidate) => candidate.path === file.path)?.action;
    if (action === 'created' || action === 'updated') {
      atomicWriteProjectFile(join(project, file.path), file.content);
    }
  }
  const removed = actions
    .filter((action) => action.action === 'removed')
    .map((action) => action.path);
  if (removed.length > 0) removeProductSkillFiles({ project, target, paths: removed });
  writeProductSkillState(project, state);
}

function targetFiles(
  bundle: RenderedProductSkillBundleV1,
  target: AgentTarget,
): readonly RenderedProductSkillFileV1[] {
  const files = bundle.files.filter((file) => file.target === target);
  if (files.length !== 2) {
    throw new Error(`App Package renderer did not return two ${target} files`);
  }
  return files;
}

function samePaths(
  left: readonly { readonly path: string }[],
  right: readonly { readonly path: string }[],
): boolean {
  return (
    left.length === right.length && left.every((file, index) => file.path === right[index]?.path)
  );
}

function sameState(left: ProductSkillState, right: ProductSkillState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function blockedTarget(
  target: AgentTarget,
  statePath: string,
  files: readonly RenderedProductSkillFileV1[],
  message: string,
  issue: Partial<Pick<AgentProductSkillIssue, 'code' | 'recovery'>> = {},
): ProductSkillTargetReport {
  const code = issue.code ?? 'agent_skill_modified';
  return {
    target,
    status: 'modified',
    statePath,
    applied: false,
    requiresRegeneration: true,
    stateAction: 'unchanged',
    files: files.map((file) => ({ path: file.path, action: 'skipped', reason: message })),
    issue: { code, message, ...(issue.recovery === undefined ? {} : { recovery: issue.recovery }) },
  };
}

function invalidTarget(
  target: AgentTarget,
  statePath: string,
  files: readonly RenderedProductSkillFileV1[],
  message: string,
): ProductSkillTargetReport {
  return blockedTarget(target, statePath, files, message, { code: 'agent_skill_invalid_state' });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown app product skill reconciliation error';
}
