import { describe, expect, it } from 'vitest';
import { validateReleasePolicy } from '../../../scripts/release-policy.mjs';

const production = {
  name: 'production',
  can_admins_bypass: false,
  protection_rules: [
    {
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { id: 1 } }],
    },
    { type: 'branch_policy' },
  ],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

describe('release policy', () => {
  it('accepts the locked production environment and sole release workflow', () => {
    expect(
      validateReleasePolicy({ environments: [production], staticErrors: [], rulesetErrors: [] }),
    ).toEqual([]);
  });

  it('reports every live bypass', () => {
    expect(
      validateReleasePolicy({
        environments: [
          { ...production, can_admins_bypass: true, deployment_branch_policy: null },
          { name: 'production-website' },
        ],
        staticErrors: ['publish-cli.yml can publish npm'],
        rulesetErrors: ['main ruleset must require a merge queue'],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/administrator bypass/i),
        expect.stringMatching(/protected branches/i),
        expect.stringMatching(/production-website/i),
        'publish-cli.yml can publish npm',
        'main ruleset must require a merge queue',
      ]),
    );
  });
});
