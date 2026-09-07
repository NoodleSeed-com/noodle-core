import { z } from 'zod';
import { isRecord } from './parse-document.js';

const urlTemplateSchema = z.string().refine((value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a URL');

const bridgeUserClaimsSchema = z
  .object({
    id: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
    orgs: z.string().min(1).optional(),
    roles: z.string().min(1).optional(),
    scopes: z.string().min(1).optional(),
  })
  .strict();

const oidcServerAuthSchema = z
  .object({
    kind: z.literal('oidc').optional(),
    issuer: z.url(),
    audience: z.string().min(1),
    claims: bridgeUserClaimsSchema.optional(),
  })
  .strict();

const CUSTOMER_ENDPOINT_NAME_PATTERN = /^[a-z0-9_]+$/;
const CUSTOMER_ENDPOINT_CLAIM_PATH_PATTERN = /^[^.]+(?:\.[^.]+)*$/u;

export interface CustomerEndpointClaimMapping {
  readonly claim: string;
}

const customerEndpointNameSchema = z.string().regex(CUSTOMER_ENDPOINT_NAME_PATTERN);
const customerEndpointClaimMappingSchema = z
  .object({
    claim: z
      .string()
      .regex(
        CUSTOMER_ENDPOINT_CLAIM_PATH_PATTERN,
        'claim path must contain nonempty dot-separated segments',
      ),
  })
  .strict();

function safeEndpointMappingCopy(
  value: unknown,
): Readonly<Record<string, CustomerEndpointClaimMapping>> {
  const copy: Record<string, CustomerEndpointClaimMapping> = Object.create(null);
  if (!isRecord(value)) return copy;
  for (const [name, mapping] of Object.entries(value)) {
    if (!isRecord(mapping) || typeof mapping.claim !== 'string') continue;
    copy[name] = { claim: mapping.claim };
  }
  return copy;
}

const customerEndpointMappingsSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (!isRecord(value)) {
      context.addIssue({
        code: 'custom',
        message: 'routing endpoints must be an object',
      });
      return;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'routing endpoints cannot be empty',
      });
    }
    for (const [name, mapping] of entries) {
      const parsedName = customerEndpointNameSchema.safeParse(name);
      if (!parsedName.success) {
        for (const issue of parsedName.error.issues) {
          context.addIssue({
            code: 'custom',
            path: [name, ...issue.path],
            message: issue.message,
          });
        }
      }
      const parsedMapping = customerEndpointClaimMappingSchema.safeParse(mapping);
      if (!parsedMapping.success) {
        for (const issue of parsedMapping.error.issues) {
          context.addIssue({
            code: 'custom',
            path: [name, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  })
  .overwrite(safeEndpointMappingCopy)
  .meta({
    type: 'object',
    minProperties: 1,
    propertyNames: {
      type: 'string',
      pattern: CUSTOMER_ENDPOINT_NAME_PATTERN.source,
    },
    additionalProperties: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          pattern: CUSTOMER_ENDPOINT_CLAIM_PATH_PATTERN.source,
        },
      },
      required: ['claim'],
      additionalProperties: false,
    },
  }) as z.ZodType<Readonly<Record<string, CustomerEndpointClaimMapping>>>;

const customerAuthRoutingSchema = z
  .object({
    endpoints: customerEndpointMappingsSchema,
  })
  .strict();

const oidcServerAuthV2Schema = z
  .object({
    kind: z.literal('oidc').optional(),
    issuer: z.url(),
    audience: z.string().min(1),
    claims: bridgeUserClaimsSchema.optional(),
    routing: customerAuthRoutingSchema.optional(),
  })
  .strict();

const bridgeServerAuthSchema = z
  .object({
    kind: z.literal('bridge'),
    provider: z.string().trim().min(1),
    verifyUrl: urlTemplateSchema.optional(),
    authorizeUrl: urlTemplateSchema.optional(),
    projectId: z.string().trim().min(1).optional(),
    apiKey: z.string().trim().min(1).optional(),
    authDomain: z.string().trim().min(1).optional(),
    appId: z.string().trim().min(1).optional(),
    tenantId: z.string().trim().min(1).optional(),
    audience: z.string().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z
      .string()
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
    tokenUrl: urlTemplateSchema.optional(),
    scopes: z.array(z.string().trim().min(1)).optional(),
    authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
    user: bridgeUserClaimsSchema.optional(),
  })
  .strict();

export const serverAuthSchema = z.union([bridgeServerAuthSchema, oidcServerAuthSchema]);

const federatedOidcIssuerSchema = z
  .object({
    issuer: z.url(),
    audience: z.string().min(1),
    claims: bridgeUserClaimsSchema.optional(),
    routing: customerAuthRoutingSchema.optional(),
  })
  .strict();

const federatedOidcIssuersSchema = z
  .array(federatedOidcIssuerSchema)
  .min(1)
  .max(16)
  .superRefine((issuers, context) => {
    const seen = new Set<string>();
    issuers.forEach(({ issuer }, index) => {
      const normalizedIssuer = issuer.replace(/\/+$/u, '');
      if (seen.has(normalizedIssuer)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'issuer'],
          message: 'federated OIDC issuers must be unique after trailing-slash normalization',
        });
        return;
      }
      seen.add(normalizedIssuer);
    });
  });

const federatedOidcServerAuthSchema = z
  .object({
    kind: z.literal('federatedOidc'),
    issuers: federatedOidcIssuersSchema,
  })
  .strict();

const builtInBridgeServerAuthSchema = bridgeServerAuthSchema.refine(
  (auth) => auth.provider === 'firebase' || auth.provider === 'microsoft',
  { message: 'Core v2 supports only the firebase and microsoft managed bridge providers' },
);

export const serverAuthV2Schema = z.union([
  oidcServerAuthV2Schema,
  federatedOidcServerAuthSchema,
  builtInBridgeServerAuthSchema,
]);
