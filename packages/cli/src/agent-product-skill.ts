import {
  type AgentTarget,
  type RenderedProductSkillBundleV1,
  renderProductSkillBundle,
} from '@noodle-borg/agent-kit';
import type { AppPackageArtifactV1 } from '@noodle-borg/compiler';
import {
  orphanedProductSkillSetupReport,
  reconcileProductSkillTarget,
} from './agent-product-skill-reconcile.js';
import { compileLocalInput } from './local-compile.js';
import { resolveLocalEntrypoint } from './project.js';

export type AgentProductSkillCode =
  | 'agent_skill_invalid_state'
  | 'agent_skill_modified'
  | 'agent_skill_stale';

export interface AgentProductSkillIssue {
  readonly code: AgentProductSkillCode;
  readonly message: string;
  readonly recovery?: 'replace_modified_app_skill';
  readonly target?: AgentTarget;
}

export interface ProductSkillFileAction {
  readonly path: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'removed' | 'skipped';
  readonly reason?: string;
}

export interface ProductSkillTargetReport {
  readonly target: AgentTarget;
  readonly status: 'created' | 'updated' | 'unchanged' | 'modified' | 'stale' | 'removed';
  readonly statePath: string;
  readonly applied: boolean;
  readonly requiresRegeneration: boolean;
  readonly stateAction: 'created' | 'updated' | 'unchanged' | 'migrated' | 'removed';
  readonly files: readonly ProductSkillFileAction[];
  readonly issue?: AgentProductSkillIssue;
}

export interface ProductSkillSetupReport {
  readonly ok: boolean;
  readonly app?: { readonly name: string; readonly skillSlug: string };
  readonly sourceManifestSha256?: string;
  readonly mcpSurfaceSha256?: string;
  readonly rendererVersion?: string;
  readonly bundleSha256?: string;
  readonly targets: readonly ProductSkillTargetReport[];
  readonly issues: readonly AgentProductSkillIssue[];
}

export type ProductSkillCompilation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unguided' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly artifact: AppPackageArtifactV1;
      readonly bundle: RenderedProductSkillBundleV1;
      readonly skillSlug: string;
    };

/** Compile the local TypeScript project without auth or network, then invoke the pure Agent Kit renderer. */
export async function compileProjectProductSkill(
  project: string,
): Promise<ProductSkillCompilation> {
  const entrypoint = resolveLocalEntrypoint(project);
  if (entrypoint === undefined) return { kind: 'absent' };
  const compiled = await compileLocalInput({ manifestPath: entrypoint });
  if (!compiled.ok) {
    return {
      kind: 'error',
      message: `Local app compilation failed at the ${compiled.stage} stage; run noodle validate.`,
    };
  }
  if (compiled.compiled.appPackage === undefined) return { kind: 'unguided' };
  try {
    const artifact = compiled.compiled.appPackage;
    const bundle = renderProductSkillBundle(artifact);
    const skillFile = bundle.files.find(
      (file) => file.target === 'codex' && file.path.endsWith('/SKILL.md'),
    );
    const skillSlug = skillFile?.path.split('/').at(-2);
    if (skillSlug === undefined) throw new Error('rendered app skill has no canonical slug');
    return { kind: 'ready', artifact, bundle, skillSlug };
  } catch {
    return {
      kind: 'error',
      message: 'The local App Package could not be rendered safely; run noodle validate.',
    };
  }
}

export function setupProjectProductSkill(input: {
  readonly project: string;
  readonly targets: readonly AgentTarget[];
  readonly write: boolean;
  readonly regenerateAppSkill?: boolean;
  readonly replaceModifiedAppSkill?: boolean;
  readonly compilation: ProductSkillCompilation;
}): ProductSkillSetupReport | undefined {
  if (input.compilation.kind === 'absent' || input.compilation.kind === 'unguided') {
    return orphanedProductSkillSetupReport(input);
  }
  if (input.compilation.kind === 'error') {
    return {
      ok: false,
      targets: [],
      issues: [{ code: 'agent_skill_stale', message: input.compilation.message }],
    };
  }
  const { artifact, bundle, skillSlug } = input.compilation;
  const targets = input.targets.map((target) =>
    reconcileProductSkillTarget({
      project: input.project,
      target,
      write: input.write,
      regenerateAppSkill: input.regenerateAppSkill === true,
      replaceModifiedAppSkill: input.replaceModifiedAppSkill === true,
      artifact,
      bundle,
      skillSlug,
    }),
  );
  const issues = targets.flatMap((target) =>
    target.issue === undefined ? [] : [{ ...target.issue, target: target.target }],
  );
  return {
    ok: issues.length === 0,
    app: { name: artifact.app.name, skillSlug },
    sourceManifestSha256: artifact.provenance.sourceManifestSha256,
    mcpSurfaceSha256: artifact.provenance.mcpSurfaceSha256,
    rendererVersion: bundle.rendererVersion,
    bundleSha256: bundle.bundleSha256,
    targets,
    issues,
  };
}
