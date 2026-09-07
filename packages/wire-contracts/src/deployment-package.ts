import { appPackageSnapshotV1Schema } from '@noodle-borg/app-package';
import { z } from 'zod';

export const DeploymentPackageDataSchema = z
  .object({
    deploymentId: z.string().min(1),
    appSlug: z.string().min(1),
    environment: z.string().min(1),
    serverVersion: z.string().min(1).optional(),
    active: z.boolean(),
    archivedAt: z.string().optional(),
    snapshot: appPackageSnapshotV1Schema,
  })
  .strict();

/** Strict structural wire response; the service adds Agent Kit host-file refinement before sending. */
export const DeploymentPackageResponseShapeSchema = z
  .object({
    ok: z.literal(true),
    data: DeploymentPackageDataSchema,
  })
  .strict();

export type DeploymentPackageResponse = z.output<typeof DeploymentPackageResponseShapeSchema>;
export type DeploymentPackageData = DeploymentPackageResponse['data'];
