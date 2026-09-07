import { z } from 'zod';

export const EXTERNAL_CREDENTIAL_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:token-exchange' as const;
export const EXTERNAL_CREDENTIAL_SUBJECT_TOKEN_TYPE =
  'urn:ietf:params:oauth:token-type:jwt' as const;
export const EXTERNAL_CREDENTIAL_MAX_EXPIRES_IN_SECONDS = 3_600;
export const EXTERNAL_CREDENTIAL_SCOPE_FORM_MAX_LENGTH = 8_192;

export const externalCredentialIdentifierSchema = z
  .string()
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'identifier must contain only visible ASCII characters');
export const externalCredentialIssuerSchema = z
  .string()
  .max(2_048)
  .regex(/^[\x21-\x7e]+$/, 'issuer must contain only visible ASCII characters')
  .url();
export const externalCredentialAudienceSchema = externalCredentialIdentifierSchema;
export const externalCredentialScopeTokenSchema = z
  .string()
  .max(512)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, 'scope must use RFC 6749 scope-token characters');
export const externalCredentialScopeArraySchema = z
  .array(externalCredentialScopeTokenSchema)
  .max(128)
  .superRefine((scopes, context) => {
    const canonical = [...scopes].sort();
    if (scopes.join(' ').length > EXTERNAL_CREDENTIAL_SCOPE_FORM_MAX_LENGTH) {
      context.addIssue({ code: 'custom', message: 'scopes exceed the aggregate form limit' });
    }
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({ code: 'custom', message: 'scopes must not contain duplicates' });
    }
    if (scopes.some((scope, index) => scope !== canonical[index])) {
      context.addIssue({ code: 'custom', message: 'scopes must use canonical sorted order' });
    }
  });
export const externalCredentialHeaderNameSchema = z
  .string()
  .max(256)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'header must use HTTP field-name token characters');

const externalCredentialScopeFormSchema = z
  .string()
  .max(EXTERNAL_CREDENTIAL_SCOPE_FORM_MAX_LENGTH)
  .superRefine((scope, context) => {
    const scopes = scope.split(' ');
    const result = externalCredentialScopeArraySchema.safeParse(scopes);
    if (!result.success || scope !== scopes.join(' ')) {
      context.addIssue({ code: 'custom', message: 'scope must be a canonical scope-token list' });
    }
  });
const opaqueIdentifier = externalCredentialIdentifierSchema;

export const externalCredentialPresentationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }).strict(),
  z
    .object({
      kind: z.literal('apiKey'),
      header: externalCredentialHeaderNameSchema,
    })
    .strict(),
]);

export const externalCredentialWorkloadClaimsSchema = z
  .object({
    iss: externalCredentialIssuerSchema,
    aud: externalCredentialAudienceSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: externalCredentialIdentifierSchema,
    tenant: externalCredentialIdentifierSchema,
    deployment: externalCredentialIdentifierSchema,
    connector_id: externalCredentialIdentifierSchema,
    connector_version: externalCredentialIdentifierSchema,
    operation: externalCredentialIdentifierSchema,
    binding_id: externalCredentialIdentifierSchema,
    connection_id: externalCredentialIdentifierSchema,
    connection_revision: externalCredentialIdentifierSchema,
    profile: externalCredentialIdentifierSchema,
    presentation: externalCredentialPresentationSchema,
    scopes: externalCredentialScopeArraySchema,
    requested_audience: externalCredentialAudienceSchema.optional(),
  })
  .strict();

export type ExternalCredentialWorkloadClaims = z.infer<
  typeof externalCredentialWorkloadClaimsSchema
>;
export const externalCredentialWorkloadInputSchema = externalCredentialWorkloadClaimsSchema.omit({
  iss: true,
  aud: true,
  iat: true,
  exp: true,
  jti: true,
});
export type ExternalCredentialWorkloadInput = z.infer<typeof externalCredentialWorkloadInputSchema>;

export const externalCredentialExchangeRequestSchema = z
  .object({
    grant_type: z.literal(EXTERNAL_CREDENTIAL_GRANT_TYPE),
    subject_token_type: z.literal(EXTERNAL_CREDENTIAL_SUBJECT_TOKEN_TYPE),
    subject_token: z
      .string()
      .max(65_536)
      .regex(/^[\x21-\x7e]+$/),
    scope: externalCredentialScopeFormSchema.optional(),
    audience: externalCredentialAudienceSchema.optional(),
  })
  .strict();

export type ExternalCredentialExchangeRequest = z.infer<
  typeof externalCredentialExchangeRequestSchema
>;

export const externalCredentialExchangeResponseSchema = z
  .object({
    access_token: z
      .string()
      .min(1)
      .max(32_768)
      .regex(/^[\x21-\x7e]+$/),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().max(EXTERNAL_CREDENTIAL_MAX_EXPIRES_IN_SECONDS),
    connection_subject: opaqueIdentifier,
    connection_revision: opaqueIdentifier,
  })
  .strict();

export type ExternalCredentialExchangeResponse = z.infer<
  typeof externalCredentialExchangeResponseSchema
>;

export function externalCredentialRequestFromForm(
  body: string | URLSearchParams,
): ExternalCredentialExchangeRequest {
  const params = typeof body === 'string' ? new URLSearchParams(body) : body;
  const input: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in input) throw new Error('external credential request contains a duplicate field');
    input[key] = value;
  }
  return externalCredentialExchangeRequestSchema.parse(input);
}

/** Explicitly canonicalize descriptor scopes before they enter signed claims or form encoding. */
export function canonicalizeExternalCredentialScopes(scopes: readonly string[]): readonly string[] {
  return externalCredentialScopeArraySchema.parse([...scopes].sort());
}
