const DESIGN_SESSION_VERSION = 1 as const;
export const DESIGN_MAX_BODY_BYTES = 256 * 1024;

export const DESIGN_STYLE_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'background-color',
  'opacity',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'row-gap',
  'column-gap',
  'display',
  'flex-direction',
  'align-items',
  'justify-content',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
] as const;

type DesignStyleProperty = (typeof DESIGN_STYLE_PROPERTIES)[number];

interface DesignStyleChangeV1 {
  readonly property: DesignStyleProperty;
  readonly from: string;
  readonly to: string;
}

export interface ElementFingerprintV1 {
  readonly tagName: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly visibleText?: string;
  readonly stableId?: string;
  readonly classNames: readonly string[];
  readonly authorHints: {
    readonly testId?: string;
    readonly test?: string;
    readonly component?: string;
  };
  readonly ancestry: readonly {
    readonly tagName: string;
    readonly role?: string;
    readonly stableId?: string;
    readonly classNames: readonly string[];
    readonly nthOfType: number;
  }[];
  readonly siblingIndex: number;
  readonly siblingCount: number;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly computedStyles: Readonly<Partial<Record<DesignStyleProperty, string>>>;
  readonly resolution: {
    readonly confidence: number;
    readonly evidence: readonly string[];
    readonly status: 'resolved' | 'ambiguous' | 'unresolved';
  };
}

export interface DesignAnnotationV1 {
  readonly id: string;
  readonly intent: string;
  readonly target: ElementFingerprintV1;
  readonly changes: readonly DesignStyleChangeV1[];
  readonly acceptanceCriteria: readonly string[];
  readonly preserve: readonly string[];
}

export interface DesignSessionV1 {
  readonly version: 1;
  readonly id: string;
  readonly status: 'draft' | 'ready';
  readonly project: {
    readonly entrypoint: string;
    readonly toolName: string;
    readonly resourceUri?: string;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly device: 'desktop' | 'mobile';
    readonly theme: 'light' | 'dark';
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly annotations: readonly DesignAnnotationV1[];
}

type JsonRecord = Record<string, unknown>;
const STYLE_PROPERTY_SET = new Set<string>(DESIGN_STYLE_PROPERTIES);
const GENERATED_ID =
  /^(?::r\d+:|react[-_:]|radix[-_:]|headlessui[-_:]|[a-f0-9]{12,}|[A-Za-z_-]*\d{7,})$/i;

function object(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function only(value: JsonRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`unknown ${path} field: ${unknown}`);
}

function text(value: unknown, path: string, max = 4000): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  if (value.length > max) throw new Error(`${path} must contain at most ${max} characters`);
  return value;
}

function optionalText(value: unknown, path: string, max = 4000): string | undefined {
  return value === undefined ? undefined : text(value, path, max);
}

function projectRelativePath(value: unknown, path: string): string {
  const parsed = text(value, path, 500);
  const normalized = parsed.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${path} must be project-relative`);
  }
  return parsed;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const parsed = finite(value, path);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${path} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > max) throw new Error(`${path} must contain at most ${max} items`);
  return value;
}

function stringList(value: unknown, path: string, max: number, itemMax = 500): string[] {
  return list(value, path, max).map((item, index) => text(item, `${path}[${index}]`, itemMax));
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new Error(`${path} must be one of ${choices.join(', ')}`);
  }
  return value as T[number];
}

function timestamp(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
  const date = new Date(parsed);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
  return parsed;
}

function stableId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = sanitizeVisibleText(value);
  if (normalized.length === 0 || normalized.length > 120 || GENERATED_ID.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function optionalSanitized(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = sanitizeVisibleText(value).slice(0, max);
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizedClasses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => sanitizeVisibleText(item).slice(0, 120))
    .filter(Boolean)
    .sort()
    .slice(0, 20);
}

function rect(value: unknown, path: string): ElementFingerprintV1['rect'] {
  const input = object(value, path);
  only(input, ['x', 'y', 'width', 'height'], path);
  return {
    x: finite(input.x, `${path}.x`),
    y: finite(input.y, `${path}.y`),
    width: finite(input.width, `${path}.width`),
    height: finite(input.height, `${path}.height`),
  };
}

function computedStyles(
  value: unknown,
  path: string,
): Partial<Record<DesignStyleProperty, string>> {
  const input = object(value, path);
  const result: Partial<Record<DesignStyleProperty, string>> = {};
  for (const [property, raw] of Object.entries(input)) {
    if (!STYLE_PROPERTY_SET.has(property)) continue;
    result[property as DesignStyleProperty] = text(raw, `${path}.${property}`, 500);
  }
  return result;
}

function resolution(value: unknown, path: string): ElementFingerprintV1['resolution'] {
  const input = object(value, path);
  only(input, ['confidence', 'evidence', 'status'], path);
  const confidence = finite(input.confidence, `${path}.confidence`);
  if (confidence < 0 || confidence > 100) {
    throw new Error(`${path}.confidence must be between 0 and 100`);
  }
  return {
    confidence,
    evidence: stringList(input.evidence, `${path}.evidence`, 20, 160),
    status: enumValue(
      input.status,
      ['resolved', 'ambiguous', 'unresolved'] as const,
      `${path}.status`,
    ),
  };
}

function ancestry(value: unknown, path: string, strict: boolean): ElementFingerprintV1['ancestry'] {
  return list(value, path, strict ? 6 : Number.MAX_SAFE_INTEGER)
    .slice(0, 6)
    .map((item, index) => {
      const segmentPath = `${path}[${index}]`;
      const input = object(item, segmentPath);
      if (strict) {
        only(input, ['tagName', 'role', 'stableId', 'classNames', 'nthOfType'], segmentPath);
      }
      const id = stableId(input.stableId ?? input.id);
      const role = optionalSanitized(input.role, 80);
      return {
        tagName: text(input.tagName, `${segmentPath}.tagName`, 40).toLowerCase(),
        ...(role ? { role } : {}),
        ...(id ? { stableId: id } : {}),
        classNames: sanitizedClasses(input.classNames),
        nthOfType: integer(input.nthOfType, `${segmentPath}.nthOfType`, 1),
      };
    });
}

export function sanitizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function sanitizeElementEvidenceAt(
  value: unknown,
  path: string,
  strict = false,
): ElementFingerprintV1 {
  const input = object(value, path);
  const attributes =
    input.attributes === undefined ? {} : object(input.attributes, `${path}.attributes`);
  const providedHints =
    input.authorHints === undefined ? {} : object(input.authorHints, `${path}.authorHints`);
  const id = stableId(input.stableId ?? input.id);
  const testId = optionalSanitized(providedHints.testId ?? attributes['data-testid'], 120);
  const test = optionalSanitized(providedHints.test ?? attributes['data-test'], 120);
  const component = optionalSanitized(providedHints.component ?? attributes['data-component'], 120);
  const authorHints = {
    ...(testId ? { testId } : {}),
    ...(test ? { test } : {}),
    ...(component ? { component } : {}),
  };
  const accessibleName = optionalSanitized(input.accessibleName);
  const visibleText = optionalSanitized(input.visibleText);
  const role = optionalSanitized(input.role, 80);
  return {
    tagName: text(input.tagName, `${path}.tagName`, 40).toLowerCase(),
    ...(role ? { role } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    ...(visibleText ? { visibleText } : {}),
    ...(id ? { stableId: id } : {}),
    classNames: sanitizedClasses(input.classNames),
    authorHints,
    ancestry: ancestry(input.ancestry, `${path}.ancestry`, strict),
    siblingIndex: integer(input.siblingIndex, `${path}.siblingIndex`),
    siblingCount: integer(input.siblingCount, `${path}.siblingCount`),
    rect: rect(input.rect, `${path}.rect`),
    computedStyles: computedStyles(input.computedStyles, `${path}.computedStyles`),
    resolution: resolution(input.resolution, `${path}.resolution`),
  };
}

export function sanitizeElementEvidence(value: unknown): ElementFingerprintV1 {
  return sanitizeElementEvidenceAt(value, 'element');
}

function validateTarget(value: unknown, path: string): ElementFingerprintV1 {
  const input = object(value, path);
  only(
    input,
    [
      'tagName',
      'role',
      'accessibleName',
      'visibleText',
      'stableId',
      'classNames',
      'authorHints',
      'ancestry',
      'siblingIndex',
      'siblingCount',
      'rect',
      'computedStyles',
      'resolution',
    ],
    path,
  );
  const hints = object(input.authorHints, `${path}.authorHints`);
  only(hints, ['testId', 'test', 'component'], `${path}.authorHints`);
  const styles = object(input.computedStyles, `${path}.computedStyles`);
  const unsupportedStyle = Object.keys(styles).find(
    (property) => !STYLE_PROPERTY_SET.has(property),
  );
  if (unsupportedStyle)
    throw new Error(`${path}.computedStyles.${unsupportedStyle} is unsupported`);
  return sanitizeElementEvidenceAt(input, path, true);
}

function validateChange(value: unknown, path: string): DesignStyleChangeV1 {
  const input = object(value, path);
  only(input, ['property', 'from', 'to'], path);
  if (typeof input.property !== 'string' || !STYLE_PROPERTY_SET.has(input.property)) {
    throw new Error(`${path}.property is unsupported`);
  }
  return {
    property: input.property as DesignStyleProperty,
    from: text(input.from, `${path}.from`, 500),
    to: text(input.to, `${path}.to`, 500),
  };
}

function validateAnnotation(value: unknown, path: string): DesignAnnotationV1 {
  const input = object(value, path);
  only(input, ['id', 'intent', 'target', 'changes', 'acceptanceCriteria', 'preserve'], path);
  return {
    id: text(input.id, `${path}.id`, 120),
    intent: text(input.intent, `${path}.intent`, 4000),
    target: validateTarget(input.target, `${path}.target`),
    changes: list(input.changes, `${path}.changes`, 100).map((item, index) =>
      validateChange(item, `${path}.changes[${index}]`),
    ),
    acceptanceCriteria: stringList(input.acceptanceCriteria, `${path}.acceptanceCriteria`, 50),
    preserve: stringList(input.preserve, `${path}.preserve`, 50),
  };
}

export function validateDesignSession(value: unknown): DesignSessionV1 {
  const input = object(value, 'Design Session');
  only(
    input,
    ['version', 'id', 'status', 'project', 'viewport', 'createdAt', 'updatedAt', 'annotations'],
    'Design Session',
  );
  if (input.version !== DESIGN_SESSION_VERSION) {
    throw new Error('unsupported Design Session version');
  }
  const project = object(input.project, 'Design Session project');
  only(project, ['entrypoint', 'toolName', 'resourceUri'], 'Design Session project');
  const viewport = object(input.viewport, 'Design Session viewport');
  only(viewport, ['width', 'height', 'device', 'theme'], 'Design Session viewport');
  const resourceUri = optionalText(project.resourceUri, 'project.resourceUri', 500);
  return {
    version: DESIGN_SESSION_VERSION,
    id: text(input.id, 'id', 120),
    status: enumValue(input.status, ['draft', 'ready'] as const, 'status'),
    project: {
      entrypoint: projectRelativePath(project.entrypoint, 'project.entrypoint'),
      toolName: text(project.toolName, 'project.toolName', 200),
      ...(resourceUri ? { resourceUri } : {}),
    },
    viewport: {
      width: finite(viewport.width, 'viewport.width'),
      height: finite(viewport.height, 'viewport.height'),
      device: enumValue(viewport.device, ['desktop', 'mobile'] as const, 'viewport.device'),
      theme: enumValue(viewport.theme, ['light', 'dark'] as const, 'viewport.theme'),
    },
    createdAt: timestamp(input.createdAt, 'createdAt'),
    updatedAt: timestamp(input.updatedAt, 'updatedAt'),
    annotations: list(input.annotations, 'annotations', 100).map((item, index) =>
      validateAnnotation(item, `annotations[${index}]`),
    ),
  };
}
