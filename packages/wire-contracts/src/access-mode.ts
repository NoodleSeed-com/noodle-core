import { z } from 'zod';

/** Canonical six data-plane access modes shared by every wire contract. */
export const ACCESS_MODES = [
  'owner-only',
  'org-members',
  'authenticated',
  'public',
  'mixed',
  'customers',
] as const;

export const accessModeSchema = z.enum(ACCESS_MODES);
export type AccessMode = z.infer<typeof accessModeSchema>;
