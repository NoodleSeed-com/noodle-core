import { createHash } from 'node:crypto';
import type { ProductSkillPackageInput } from './product-skill-types.js';

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[a-z0-9_]+$/;
const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_FALLBACK_SLUG = /^n-h[a-f0-9]{59}-n$/;
const MAX_HOST_SKILL_SLUG_CHARS = 64;
const FALLBACK_DIGEST_CHARS = 59;
const MAX_IDENTIFIER_CHARS = 200;
const MAX_PROSE_CHARS = 4_000;
const MAX_USE_WHEN = 32;
const MAX_WORKFLOWS = 32;
const MAX_WORKFLOW_STEPS = 64;
const MAX_BOUNDARIES = 64;
const MAX_EXAMPLES = 64;
const MAX_SURFACE_ITEMS = 256;
const MAX_SCHEMA_FIELDS = 64;
const MAX_PROMPT_ARGUMENTS = 64;
const MAX_AUTHORIZATION_VALUES = 128;
const MAX_SCOPE_CHARS = 512;
const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Drift-testable validation bounds; Agent Kit stays runtime-dependency-free. */
export const PRODUCT_SKILL_VALIDATION_LIMITS = Object.freeze({
  identifierChars: MAX_IDENTIFIER_CHARS,
  proseChars: MAX_PROSE_CHARS,
  useWhen: MAX_USE_WHEN,
  workflows: MAX_WORKFLOWS,
  workflowSteps: MAX_WORKFLOW_STEPS,
  boundaries: MAX_BOUNDARIES,
  examples: MAX_EXAMPLES,
  surfaceItems: MAX_SURFACE_ITEMS,
  schemaFields: MAX_SCHEMA_FIELDS,
  promptArguments: MAX_PROMPT_ARGUMENTS,
  authorizationValues: MAX_AUTHORIZATION_VALUES,
  artifactBytes: MAX_ARTIFACT_BYTES,
});

export type ProductSkillRenderErrorCode =
  | 'app_package_invalid'
  | 'app_package_unsafe_path'
  | 'app_package_file_too_large'
  | 'app_package_total_too_large'
  | 'app_package_sensitive_content';

/** A stable, non-echoing failure for invalid generated product-skill packages. */
export class ProductSkillRenderError extends Error {
  constructor(readonly code: ProductSkillRenderErrorCode) {
    super(`product skill rendering failed: ${code}`);
    this.name = 'ProductSkillRenderError';
  }
}

/** Validate the compiler-compatible public input before either Markdown or bundle rendering. */
export function validateProductSkillPackageInput(input: ProductSkillPackageInput): void {
  if (!isRecord(input) || input.schemaVersion !== '1') fail('app_package_invalid');
  const app = input.app;
  if (!isRecord(app) || typeof app.name !== 'string') fail('app_package_invalid');
  if (hasUnsafePathCharacters(app.name)) fail('app_package_unsafe_path');
  if (!NAME_PATTERN.test(app.name)) fail('app_package_invalid');
  if (
    !boundedProse(app.title) ||
    !boundedProse(app.version) ||
    (app.branding !== undefined && !isValidBranding(app.branding))
  )
    fail('app_package_invalid');
  if (!isValidSkill(input.skill) || !isValidSurface(input.surface) || !isRecord(input.provenance))
    fail('app_package_invalid');
  if (
    !HEX_SHA256.test(input.provenance.sourceManifestSha256) ||
    !HEX_SHA256.test(input.provenance.mcpSurfaceSha256) ||
    input.provenance.compilerVersion !== '1'
  )
    fail('app_package_invalid');
  if (serializedBytes(input) > MAX_ARTIFACT_BYTES) fail('app_package_invalid');
  const sensitiveFinding = sensitiveContentFinding(input);
  if (sensitiveFinding === 'scan_limit') fail('app_package_invalid');
  if (sensitiveFinding === 'sensitive') fail('app_package_sensitive_content');
}

/** Total Core-name to host-name mapping; the fallback namespace cannot collide with a simple slug. */
export function skillSlug(name: string): string {
  const simple = name.replaceAll('_', '-');
  if (
    SKILL_SLUG_PATTERN.test(simple) &&
    simple.length <= MAX_HOST_SKILL_SLUG_CHARS &&
    !RESERVED_FALLBACK_SLUG.test(simple)
  ) {
    return simple;
  }
  const digest = createHash('sha256').update(name).digest('hex');
  return `n-h${digest.slice(0, FALLBACK_DIGEST_CHARS)}-n`;
}

function isValidSkill(value: unknown): boolean {
  if (!isRecord(value) || !boundedProse(value.description)) return false;
  if (!boundedArray(value.useWhen, 1, MAX_USE_WHEN, (entry) => boundedProse(entry))) return false;
  if (!boundedArray(value.workflows, 1, MAX_WORKFLOWS, isValidWorkflow)) return false;
  if (!boundedArray(value.boundaries, 0, MAX_BOUNDARIES, (entry) => boundedProse(entry)))
    return false;
  return boundedArray(value.examples, 0, MAX_EXAMPLES, isValidExample);
}

function isValidBranding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const proseFields = ['name', 'accent', 'surface', 'surfaceDark'] as const;
  if (proseFields.some((field) => value[field] !== undefined && !boundedProse(value[field])))
    return false;
  const assetFields = ['logo', 'mark', 'avatar'] as const;
  if (assetFields.some((field) => value[field] !== undefined && !isValidBrandAsset(value[field])))
    return false;
  return (
    (value.radius === undefined || ['none', 'sm', 'md', 'lg'].includes(String(value.radius))) &&
    (value.density === undefined || ['compact', 'comfortable'].includes(String(value.density))) &&
    (value.typography === undefined ||
      ['system', 'serif', 'mono'].includes(String(value.typography))) &&
    (value.colorScheme === undefined ||
      ['auto', 'light', 'dark'].includes(String(value.colorScheme)))
  );
}

function isValidBrandAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    isValidSurfacePropertyName(value.logicalId) &&
    boundedProse(value.alt) &&
    (value.darkLogicalId === undefined || isValidSurfacePropertyName(value.darkLogicalId))
  );
}

function isValidWorkflow(value: unknown): boolean {
  if (!isRecord(value) || !isValidName(value.id) || !boundedProse(value.title)) return false;
  return (
    (value.intent === undefined || boundedProse(value.intent)) &&
    boundedArray(value.steps, 1, MAX_WORKFLOW_STEPS, isValidWorkflowStep)
  );
}

function isValidWorkflowStep(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.capability)) return false;
  const capability = value.capability;
  return (
    (capability.kind === 'tool' ||
      capability.kind === 'resource' ||
      capability.kind === 'prompt') &&
    isValidName(capability.name) &&
    (value.guidance === undefined || boundedProse(value.guidance)) &&
    (value.behavior === undefined || isValidBehavior(value.behavior))
  );
}

function isValidExample(value: unknown): boolean {
  return isRecord(value) && boundedProse(value.prompt) && isValidName(value.workflow);
}

function isValidSurface(value: unknown): boolean {
  if (!isRecord(value) || !isValidAuth(value.auth)) return false;
  return (
    boundedArray(value.tools, 0, MAX_SURFACE_ITEMS, isValidTool) &&
    boundedArray(value.resources, 0, MAX_SURFACE_ITEMS, isValidResource) &&
    boundedArray(value.prompts, 0, MAX_SURFACE_ITEMS, isValidPrompt) &&
    boundedArray(value.widgets, 0, MAX_SURFACE_ITEMS, isValidWidget)
  );
}

function isValidAuth(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.required === 'boolean' &&
    (value.kind === undefined || value.kind === 'oidc' || value.kind === 'federatedOidc')
  );
}

function isValidTool(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.kind !== 'tool' ||
    !isValidName(value.name) ||
    !boundedProse(value.description)
  )
    return false;
  return (
    isValidSchemaSummary(value.input) &&
    (value.output === undefined || isValidSchemaSummary(value.output)) &&
    isValidBehavior(value.behavior) &&
    isVisibility(value.visibility) &&
    (value.title === undefined || boundedProse(value.title)) &&
    (value.authorization === undefined || isValidAuthorization(value.authorization)) &&
    (value.widget === undefined || isValidName(value.widget))
  );
}

function isValidSchemaSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    boundedProse(value.type) &&
    (value.fields === undefined ||
      boundedArray(value.fields, 0, MAX_SCHEMA_FIELDS, (field) =>
        Boolean(
          isRecord(field) &&
            isValidSurfacePropertyName(field.name) &&
            boundedProse(field.type) &&
            typeof field.required === 'boolean' &&
            (field.description === undefined || boundedProse(field.description)),
        ),
      ))
  );
}

function isValidBehavior(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.readOnly === 'boolean' &&
    typeof value.destructive === 'boolean' &&
    typeof value.idempotent === 'boolean' &&
    typeof value.openWorld === 'boolean' &&
    typeof value.confirmationRequired === 'boolean'
  );
}

function isVisibility(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    ((value.length === 1 && (value[0] === 'model' || value[0] === 'app')) ||
      (value.length === 2 && value[0] === 'model' && value[1] === 'app'))
  );
}

function isValidAuthorization(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => !['requiredScopes', 'allowedRoles', 'discovery'].includes(key))
  )
    return false;
  if (value.discovery !== undefined && value.discovery !== 'public') return false;
  const scopesValid =
    value.requiredScopes === undefined ||
    boundedArray(value.requiredScopes, 1, MAX_AUTHORIZATION_VALUES, (scope) =>
      boundedProse(scope, MAX_SCOPE_CHARS),
    );
  const rolesValid =
    value.allowedRoles === undefined ||
    boundedArray(value.allowedRoles, 1, MAX_AUTHORIZATION_VALUES, (role) =>
      boundedProse(role, MAX_IDENTIFIER_CHARS),
    );
  return (
    scopesValid &&
    rolesValid &&
    (value.requiredScopes !== undefined || value.allowedRoles !== undefined)
  );
}

function isValidResource(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'resource' &&
    isValidName(value.name) &&
    boundedProse(value.uri) &&
    (value.title === undefined || boundedProse(value.title)) &&
    (value.description === undefined || boundedProse(value.description)) &&
    (value.mimeType === undefined || boundedProse(value.mimeType))
  );
}

function isValidPrompt(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'prompt' &&
    isValidName(value.name) &&
    (value.title === undefined || boundedProse(value.title)) &&
    (value.description === undefined || boundedProse(value.description)) &&
    boundedArray(value.arguments, 0, MAX_PROMPT_ARGUMENTS, (argument) =>
      Boolean(
        isRecord(argument) &&
          isValidSurfacePropertyName(argument.name) &&
          typeof argument.required === 'boolean' &&
          (argument.description === undefined || boundedProse(argument.description)),
      ),
    )
  );
}

function isValidWidget(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'widget' &&
    isValidName(value.name) &&
    isValidName(value.tool) &&
    (value.title === undefined || boundedProse(value.title)) &&
    (value.description === undefined || boundedProse(value.description))
  );
}

function isValidName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_IDENTIFIER_CHARS && NAME_PATTERN.test(value)
  );
}

function isValidSurfacePropertyName(value: unknown): value is string {
  return boundedProse(value, MAX_IDENTIFIER_CHARS);
}

function hasUnsafePathCharacters(value: string): boolean {
  return (
    value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes('..')
  );
}

/** Shared bounded credential-shape scan for generated, source-controlled artifacts. */
export function sensitiveContentFinding(value: unknown): 'sensitive' | 'scan_limit' | undefined {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9_-])/,
    /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?:$|[^A-Za-z0-9._~+/=-])/,
  ];
  let strings = 0;
  let scanLimitReached = false;
  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') {
      strings++;
      if (strings > 10_000) {
        scanLimitReached = true;
        return true;
      }
      return patterns.some((pattern) => pattern.test(current));
    }
    if (Array.isArray(current)) return current.some(visit);
    if (isRecord(current))
      return Object.keys(current)
        .sort()
        .some((key) => visit(current[key]));
    return false;
  };
  if (!visit(value)) return undefined;
  return scanLimitReached ? 'scan_limit' : 'sensitive';
}

function boundedProse(value: unknown, max = MAX_PROSE_CHARS): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function boundedArray(
  value: unknown,
  min: number,
  max: number,
  predicate: (entry: unknown) => boolean,
): value is readonly unknown[] {
  return (
    Array.isArray(value) && value.length >= min && value.length <= max && value.every(predicate)
  );
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: ProductSkillRenderErrorCode): never {
  throw new ProductSkillRenderError(code);
}
