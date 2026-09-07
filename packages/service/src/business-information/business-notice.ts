import { type BusinessNotice, BusinessNoticeSaveRequestSchema } from '@noodle-borg/wire-contracts';
import type { InstallationScope } from './contracts.js';

export interface BusinessNoticeRecord {
  readonly notice: BusinessNotice;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBySubject: string;
}
export interface BusinessNoticeInput {
  readonly scope: InstallationScope;
  readonly notice: BusinessNotice;
  readonly expectedRevision: number;
  readonly actorSubject: string;
}
export interface BusinessNoticeStore {
  getBusinessNotice(scope: InstallationScope): Promise<BusinessNoticeRecord | undefined>;
  setBusinessNotice(input: BusinessNoticeInput): Promise<BusinessNoticeRecord>;
}
export class BusinessNoticeError extends Error {
  constructor(readonly code: 'business_notice_forbidden' | 'business_notice_conflict') {
    super(
      code === 'business_notice_forbidden'
        ? 'Installation administrator required.'
        : 'Business notice changed. Reload before saving.',
    );
    this.name = 'BusinessNoticeError';
  }
}
export function validatedNotice(input: BusinessNoticeInput): BusinessNotice {
  return BusinessNoticeSaveRequestSchema.parse({
    expectedRevision: input.expectedRevision,
    notice: input.notice,
  }).notice;
}
