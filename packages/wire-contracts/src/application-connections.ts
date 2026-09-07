import { z } from 'zod';

const connectionUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}, 'HTTPS or explicit loopback HTTP URL required');

const connectionShape = {
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  state: z.enum(['unconfigured', 'ready', 'reauth_required', 'revoked']),
  revision: z.number().int().nonnegative(),
  connectable: z.boolean(),
};
export const ApplicationConnectionSchema = z.strictObject(connectionShape);
export const ApplicationConnectionsProjectionSchema = z.strictObject({
  connections: z.array(ApplicationConnectionSchema).max(100),
  canEdit: z.boolean(),
});
export type ApplicationConnectionsProjection = z.infer<
  typeof ApplicationConnectionsProjectionSchema
>;
export const ApplicationConnectionsResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: ApplicationConnectionsProjectionSchema,
});
export const ApplicationConnectionsClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    connections: z.array(z.object(connectionShape)).max(100),
    canEdit: z.boolean(),
  }),
});
const sessionBinding = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const ApplicationConnectionConnectRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  returnUrl: connectionUrl.max(2048),
  sessionBinding,
});
export const ApplicationConnectionDisconnectRequestSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});
export const ApplicationConnectionConnectResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ authorizationUrl: connectionUrl.max(8192) }),
});
export const ApplicationConnectionConnectClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ authorizationUrl: connectionUrl.max(8192) }),
});
export const ApplicationConnectionCallbackRequestSchema = z
  .strictObject({
    state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(128).optional(),
    iss: z.string().min(1).max(2048).optional(),
    sessionBinding,
  })
  .refine(
    (value) => (value.code === undefined) !== (value.error === undefined),
    'callback requires exactly one code or error',
  );
export const ApplicationConnectionCallbackResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ returnUrl: connectionUrl.max(2048) }),
});
export const ApplicationConnectionCallbackClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ returnUrl: connectionUrl.max(2048) }),
});
