import {
  type BusinessPageContent,
  BusinessPageContentSchema,
  type BusinessPagePublication,
  BusinessPagePublicationSchema,
  BusinessPagePublishRequestSchema,
  BusinessPageSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { BusinessNoticeRecord } from './business-notice.js';
import type { InstallationScope } from './contracts.js';

export interface BusinessPageRecord {
  readonly revision: number;
  readonly draft: BusinessPageContent;
  readonly published: BusinessPagePublication | null;
  readonly updatedAt: string;
  readonly updatedBySubject: string;
}
export type BusinessPageChange =
  | {
      readonly operation: 'save';
      readonly expectedRevision: number;
      readonly content: BusinessPageContent;
    }
  | { readonly operation: 'publish' | 'unpublish'; readonly expectedRevision: number };
export interface BusinessPageInput {
  readonly scope: InstallationScope;
  readonly actorSubject: string;
  readonly change: BusinessPageChange;
}
/** Server-only readiness check, never supplied by a browser or persisted as authority. */
export type BusinessPageReadiness = () => Promise<{ readonly deploymentId: string }>;
export interface BusinessPageStore {
  get(scope: InstallationScope): Promise<BusinessPageRecord | undefined>;
  update(
    input: BusinessPageInput,
    assertReady?: BusinessPageReadiness,
  ): Promise<BusinessPageRecord>;
}
export class BusinessPageError extends Error {
  constructor(
    readonly code: 'business_page_forbidden' | 'business_page_conflict' | 'business_page_not_ready',
  ) {
    super(
      {
        business_page_forbidden: 'An active business administrator is required.',
        business_page_conflict: 'The page changed. Reload before trying again.',
        business_page_not_ready:
          'Complete the business details and enable the public assistant before publishing.',
      }[code],
    );
    this.name = 'BusinessPageError';
  }
}

export async function nextBusinessPage(
  current: BusinessPageRecord | undefined,
  input: BusinessPageInput,
  now: string,
  notice: BusinessNoticeRecord | undefined,
  assertReady?: BusinessPageReadiness,
): Promise<BusinessPageRecord> {
  const { operation, ...request } = input.change;
  if (!['save', 'publish', 'unpublish'].includes(operation))
    throw new Error('Invalid page operation.');
  const save = operation === 'save' ? BusinessPageSaveRequestSchema.parse(request) : undefined;
  const expectedRevision =
    save?.expectedRevision ?? BusinessPagePublishRequestSchema.parse(request).expectedRevision;
  if ((current?.revision ?? 0) !== expectedRevision || expectedRevision === 2_147_483_647)
    throw new BusinessPageError('business_page_conflict');
  if (operation !== 'save' && !current) throw new BusinessPageError('business_page_conflict');
  const draft = save?.content ?? current?.draft;
  if (!draft) throw new BusinessPageError('business_page_conflict');
  let published = current?.published ?? null;
  if (operation === 'publish') {
    if (!notice || !assertReady) throw new BusinessPageError('business_page_not_ready');
    const ready = await assertReady();
    published = BusinessPagePublicationSchema.parse({
      content: draft,
      notice: notice.notice,
      noticeRevision: notice.revision,
      sourceRevision: expectedRevision,
      deploymentId: ready.deploymentId,
      publishedAt: now,
    });
  } else if (operation === 'unpublish') published = null;
  return structuredClone({
    revision: expectedRevision + 1,
    draft,
    published,
    updatedAt: now,
    updatedBySubject: input.actorSubject,
  });
}

/** Validate decrypted storage without surfacing parser excerpts or business text in errors. */
export function decodeBusinessPage(value: unknown, expectedRevision: number): BusinessPageRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !==
        'draft,published,revision,updatedAt,updatedBySubject' ||
      input.revision !== expectedRevision ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision > 2_147_483_647 ||
      typeof input.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.updatedAt)) ||
      typeof input.updatedBySubject !== 'string' ||
      !input.updatedBySubject ||
      input.updatedBySubject.length > 500
    )
      throw new Error();
    return {
      revision: expectedRevision,
      draft: BusinessPageContentSchema.parse(input.draft),
      published:
        input.published === null ? null : BusinessPagePublicationSchema.parse(input.published),
      updatedAt: input.updatedAt,
      updatedBySubject: input.updatedBySubject,
    };
  } catch {
    throw new Error('Business page storage is unavailable.');
  }
}
