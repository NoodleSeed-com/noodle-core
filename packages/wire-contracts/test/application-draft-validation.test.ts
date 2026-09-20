import { describe, expect, it } from 'vitest';
import {
  ApplicationDraftValidationClientResponseSchema,
  ApplicationDraftValidationResponseSchema,
} from '../src/application-draft-validation.js';

const validation = {
  draftId: '019e6c86-5838-4000-8000-019e6c865838',
  revision: 1,
  sourceDigest: 'a'.repeat(64),
  check: 'source-and-manifest',
  published: false,
  status: 'valid',
  compilerDigest: `sha256:${'b'.repeat(64)}`,
  artifactDigest: 'c'.repeat(64),
  issues: [],
};
describe('draft validation wire contract', () => {
  it('requires exact compile evidence, never a publication claim', () => {
    expect(
      ApplicationDraftValidationResponseSchema.safeParse({ ok: true, data: { validation } })
        .success,
    ).toBe(true);
    for (const change of [
      { published: true },
      { compilerDigest: undefined },
      { status: 'ready-to-publish' },
      { issues: [{ code: 'bad', message: 'bad' }] },
    ]) {
      expect(
        ApplicationDraftValidationResponseSchema.safeParse({
          ok: true,
          data: { validation: { ...validation, ...change } },
        }).success,
      ).toBe(false);
    }
  });
  it('keeps strict server output and additive client readers at every layer', () => {
    const future = {
      ok: true,
      extra: true,
      data: { extra: true, validation: { ...validation, extra: true } },
    };
    expect(ApplicationDraftValidationResponseSchema.safeParse(future).success).toBe(false);
    expect(ApplicationDraftValidationClientResponseSchema.parse(future)).toEqual({
      ok: true,
      data: { validation },
    });
  });
});
