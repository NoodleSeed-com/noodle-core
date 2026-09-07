import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRODUCT_SKILL_VALIDATION_LIMITS,
  type ProductSkillRenderError,
  renderProductSkillBundle,
} from '@noodle-borg/agent-kit';
import {
  APP_PACKAGE_V1_VALIDATION_LIMITS,
  compileManifest,
  type SensitiveContentFinding,
  sensitiveContentFinding,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const GUIDED = readFileSync(
  join(import.meta.dirname, 'fixtures/app-package-guided-v2.yaml'),
  'utf8',
);
const compiled = compileManifest(parse(GUIDED));
if (!compiled.ok || compiled.appPackage === undefined) {
  throw new Error('guided App Package parity fixture must compile');
}
const BASE = compiled.appPackage;

describe('compiler and Agent Kit App Package validation parity', () => {
  it('binds every duplicated Agent Kit bound to the compiler contract', () => {
    expect(PRODUCT_SKILL_VALIDATION_LIMITS).toEqual(APP_PACKAGE_V1_VALIDATION_LIMITS);
  });

  it.each([
    ['private_key', '-----BEGIN PRIVATE KEY-----\nredacted'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'],
    ['github_token', `ghp_${'a'.repeat(36)}`],
    ['aws_access_key', `AKIA${'A'.repeat(16)}`],
    ['bearer_credential', 'Bearer abcdefghijklmnop'],
  ] as const)('rejects the same %s credential shape at compile validation and render validation', (kind, description) => {
    expect(sensitiveContentFinding(description)?.kind).toBe(
      kind satisfies SensitiveContentFinding['kind'],
    );
    expect(() =>
      renderProductSkillBundle({
        ...BASE,
        skill: { ...BASE.skill, description },
      }),
    ).toThrowError(
      expect.objectContaining<ProductSkillRenderError>({
        code: 'app_package_sensitive_content',
      }),
    );
  });

  it.each([
    'Bearer authorization header',
    'Bearer credentials are required',
  ])('accepts ordinary authentication prose on both sides: %s', (description) => {
    expect(sensitiveContentFinding(description)).toBeUndefined();
    expect(() =>
      renderProductSkillBundle({
        ...BASE,
        skill: { ...BASE.skill, description },
      }),
    ).not.toThrow();
  });
});
