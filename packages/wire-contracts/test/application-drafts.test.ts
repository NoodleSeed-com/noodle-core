import { describe, expect, it } from 'vitest';
import {
  ApplicationDraftClientResponseSchema,
  ApplicationDraftCreateRequestSchema,
  ApplicationDraftEditRequestSchema,
  ApplicationDraftHistoryClientResponseSchema,
  ApplicationDraftHistoryResponseSchema,
  ApplicationDraftResponseSchema,
  ApplicationDraftSourceSchema,
} from '../src/application-drafts.js';
import {
  BusinessWorkspaceInvitationRequestSchema,
  BusinessWorkspaceRoleSchema,
} from '../src/business-workspaces.js';

const source = {
  entrypoint: 'server.ts',
  files: [{ path: 'server.ts', content: 'export default {};' }],
};

describe('canonical application draft inputs', () => {
  it('accepts bounded TypeScript source, never caller-supplied authority', () => {
    const input = { environment: 'prod', source };
    expect(ApplicationDraftCreateRequestSchema.parse(input)).toEqual(input);
    for (const extra of [
      { org: 'another-business' },
      { actorSubject: 'owner' },
      { published: true },
      { sourceDigest: 'a'.repeat(64) },
      { validationReceipt: 'forged' },
    ]) {
      expect(ApplicationDraftCreateRequestSchema.safeParse({ ...input, ...extra }).success).toBe(
        false,
      );
    }
  });

  it.each([
    '../server.ts',
    '/server.ts',
    'nested/../server.ts',
    'a\\b.ts',
    '.env',
    'server.js',
    'a//b.ts',
  ])('rejects unsafe or non-authoring path %s', (path) => {
    expect(
      ApplicationDraftSourceSchema.safeParse({
        ...source,
        files: [...source.files, { path, content: '' }],
      }).success,
    ).toBe(false);
  });

  it('requires a unique present TypeScript entrypoint and bounds aggregate UTF-8 bytes', () => {
    expect(
      ApplicationDraftSourceSchema.safeParse({ ...source, entrypoint: 'missing.ts' }).success,
    ).toBe(false);
    expect(
      ApplicationDraftSourceSchema.safeParse({
        ...source,
        files: [...source.files, ...source.files],
      }).success,
    ).toBe(false);
    expect(
      ApplicationDraftSourceSchema.safeParse({
        ...source,
        files: [...source.files, { path: 'large.ts', content: '🙂'.repeat(70_000) }],
      }).success,
    ).toBe(false);
  });

  it('requires a positive expected revision for edits and preserves source text exactly', () => {
    const input = { expectedRevision: 1, source };
    expect(ApplicationDraftEditRequestSchema.parse(input)).toEqual(input);
    for (const expectedRevision of [undefined, 0, -1, 1.5]) {
      expect(
        ApplicationDraftEditRequestSchema.safeParse({ ...input, expectedRevision }).success,
      ).toBe(false);
    }
    const content = '// custom code\n\nexport default {};\n';
    expect(
      ApplicationDraftSourceSchema.parse({
        ...source,
        files: [{ path: 'server.ts', content }],
      }).files[0]?.content,
    ).toBe(content);
  });

  it('keeps strict server output and additive client readers at every source and metadata layer', () => {
    const draft = {
      id: '019e6c86-5838-4000-8000-019e6c865838',
      org: 'acme',
      app: 'assistant',
      environment: 'prod',
      revision: 1,
      source,
      sourceDigest: 'a'.repeat(64),
      createdAt: '2026-09-18T00:00:00Z',
      updatedAt: '2026-09-18T00:00:00Z',
      createdBySubject: 'owner',
      updatedBySubject: 'owner',
      origin: 'manual',
    };
    const envelope = { ok: true, data: { draft } };
    expect(ApplicationDraftResponseSchema.safeParse(envelope).success).toBe(true);
    const future = {
      ...envelope,
      future: true,
      data: {
        future: true,
        draft: {
          ...draft,
          future: true,
          source: {
            ...source,
            future: true,
            files: source.files.map((file) => ({ ...file, future: true })),
          },
        },
      },
    };
    expect(ApplicationDraftResponseSchema.safeParse(future).success).toBe(false);
    expect(ApplicationDraftClientResponseSchema.parse(future)).toEqual(envelope);
    const { source: _source, ...metadata } = draft;
    const history = { ok: true, data: { revisions: [metadata] } };
    expect(ApplicationDraftHistoryResponseSchema.safeParse(history).success).toBe(true);
    expect(
      ApplicationDraftHistoryResponseSchema.safeParse({ ok: true, data: { revisions: [draft] } })
        .success,
    ).toBe(false);
    expect(ApplicationDraftHistoryClientResponseSchema.parse({ ...history, future: true })).toEqual(
      history,
    );
  });
});

describe('fixed workspace role inputs', () => {
  it('supports exactly the five agreed roles, without legacy-manager promotion', () => {
    for (const role of ['owner', 'administrator', 'builder', 'operator', 'viewer']) {
      expect(BusinessWorkspaceRoleSchema.parse(role)).toBe(role);
    }
    for (const role of ['manager', 'super_admin', 'developer', '']) {
      expect(BusinessWorkspaceRoleSchema.safeParse(role).success).toBe(false);
    }
  });

  it('defaults invitations to Operator but rejects unknown roles and authority fields', () => {
    expect(
      BusinessWorkspaceInvitationRequestSchema.parse({
        email: 'colleague@example.com',
        expectedRevision: 2,
      }),
    ).toEqual({ email: 'colleague@example.com', expectedRevision: 2, role: 'operator' });
    expect(
      BusinessWorkspaceInvitationRequestSchema.safeParse({
        email: 'colleague@example.com',
        expectedRevision: 2,
        role: 'manager',
      }).success,
    ).toBe(false);
    expect(
      BusinessWorkspaceInvitationRequestSchema.safeParse({
        email: 'colleague@example.com',
        expectedRevision: 2,
        invitedBy: 'owner',
      }).success,
    ).toBe(false);
  });
});
