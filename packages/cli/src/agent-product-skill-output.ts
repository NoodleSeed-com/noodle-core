import type { ProductSkillSetupReport } from './agent-product-skill.js';

export function productSkillRecoveryNext(
  issue: ProductSkillSetupReport['issues'][number] | undefined,
): string {
  if (issue?.code === 'agent_skill_modified' && issue.recovery === 'replace_modified_app_skill') {
    return 'Review the modified app-skill files, then preview noodle agents setup --regenerate-app-skill --replace-modified-app-skill.';
  }
  if (issue?.code === 'agent_skill_invalid_state') {
    return 'Review the app-skill ownership record without deleting local app files.';
  }
  return 'Review noodle agents setup, then rerun the exact previewed write when safe.';
}

export function nextAgentSetupCommand(
  args: { readonly write: boolean; readonly replaceModifiedAppSkill: boolean },
  productSkill: ProductSkillSetupReport | undefined,
): string | undefined {
  const issue = productSkill?.issues[0];
  if (issue?.code === 'agent_skill_modified' && issue.recovery === 'replace_modified_app_skill') {
    return 'noodle agents setup --regenerate-app-skill --replace-modified-app-skill';
  }
  if (issue !== undefined) return undefined;
  const pendingRegeneration = productSkill?.targets.some(
    (target) => target.requiresRegeneration && !target.applied && target.issue === undefined,
  );
  if (pendingRegeneration) {
    return `noodle agents setup --write --regenerate-app-skill${
      args.replaceModifiedAppSkill ? ' --replace-modified-app-skill' : ''
    }`;
  }
  return args.write ? undefined : 'noodle agents setup --write';
}
