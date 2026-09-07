import { z } from 'zod';
import { SLUG_PATTERN } from '../store/validate.js';

const printableName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !hasAsciiControlCharacters(value), 'must contain printable characters only');
const slug = z.string().regex(SLUG_PATTERN);
const scope = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const expiresAt = z.string().datetime({ offset: true }).optional();

export const createServicePrincipalSchema = z.object({ name: printableName }).strict();

export const createServicePrincipalGrantSchema = z
  .object({
    app: slug,
    environment: slug,
    scopes: z.array(scope).max(64),
  })
  .strict()
  .refine((value) => new Set(value.scopes).size === value.scopes.length, {
    message: 'scopes must not contain duplicates',
    path: ['scopes'],
  });

const credentialBase = {
  label: printableName,
  expiresAt,
};

export const createServicePrincipalCredentialSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...credentialBase,
      kind: z.literal('client_secret'),
    })
    .strict(),
  z
    .object({
      ...credentialBase,
      kind: z.literal('public_jwk'),
      algorithm: z.enum(['RS256', 'ES256']),
      publicJwk: z.object({}).catchall(z.unknown()),
    })
    .strict(),
]);

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
