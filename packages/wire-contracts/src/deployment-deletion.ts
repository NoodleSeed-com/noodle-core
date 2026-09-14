import { z } from 'zod';

const deploymentId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9-]+$/);
const ids = z
  .array(deploymentId)
  .min(1)
  .max(10000)
  .refine((values) => new Set(values).size === values.length, 'deployment IDs must be unique');
const target = {
  org: z.string().min(1),
  app: z.string().min(1),
  env: z.string().min(1),
};

/** Bind destructive version deletion to the complete inventory the operator confirmed. */
export const deploymentVersionDeleteRequestSchema = z.strictObject({ expectedDeploymentIds: ids });
export type DeploymentVersionDeleteRequest = z.infer<typeof deploymentVersionDeleteRequestSchema>;

const result = {
  ok: z.literal(true),
  deletedDeploymentIds: ids,
  auditRecorded: z.boolean(),
};
export const deploymentDeleteResponseSchema = z.strictObject({
  ...result,
  target: z.strictObject(target),
});
/** Additive response reader for clients that can outlive a service revision. */
export const deploymentDeleteClientResponseSchema = z.object({
  ...result,
  target: z.object(target),
});
export type DeploymentDeleteResponse = z.infer<typeof deploymentDeleteResponseSchema>;
