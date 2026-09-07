import type { ToolOptions } from './server.js';

const LATEST_MESSAGE_ANNOTATION = 'x-noodleseed-model-latest-message-includes-any';
const ONCE_PER_SESSION_ANNOTATION = 'x-noodleseed-model-once-per-session';
const REQUIRED_WHEN_VISIBLE_ANNOTATION = 'x-noodleseed-model-required-when-visible';
const RESERVED_ANNOTATIONS = [
  LATEST_MESSAGE_ANNOTATION,
  ONCE_PER_SESSION_ANNOTATION,
  REQUIRED_WHEN_VISIBLE_ANNOTATION,
] as const;
const MAX_PHRASES = 32;
const MAX_PHRASE_CHARS = 128;

export function manifestToolAnnotations(
  options: Pick<ToolOptions, 'annotations' | 'modelVisibility'>,
): { readonly annotations: Readonly<Record<string, unknown>> } | Record<string, never> {
  const reserved = RESERVED_ANNOTATIONS.find((annotation) =>
    Object.hasOwn(options.annotations ?? {}, annotation),
  );
  if (reserved !== undefined) {
    if (reserved === LATEST_MESSAGE_ANNOTATION) {
      throw new Error(
        `Use modelVisibility.latestMessageIncludesAny instead of the reserved ${reserved} annotation.`,
      );
    }
    throw new Error(
      `Use modelVisibility instead of the reserved model visibility annotation ${reserved}.`,
    );
  }
  if (options.modelVisibility === undefined) {
    return options.annotations ? { annotations: { ...options.annotations } } : {};
  }
  const phrases = options.modelVisibility.latestMessageIncludesAny;
  if (phrases.length < 1 || phrases.length > MAX_PHRASES) {
    throw new Error(
      `modelVisibility.latestMessageIncludesAny must contain 1-${MAX_PHRASES} literal phrases.`,
    );
  }
  const trimmed = phrases.map((phrase) => phrase.trim());
  const normalized = trimmed.map(normalize);
  if (
    trimmed.some(
      (phrase, index) => phrase.length > MAX_PHRASE_CHARS || normalized[index]?.length === 0,
    )
  ) {
    throw new Error(
      `modelVisibility.latestMessageIncludesAny phrases must contain text and be at most ${MAX_PHRASE_CHARS} characters.`,
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('modelVisibility.latestMessageIncludesAny phrases must be unique.');
  }
  return {
    annotations: {
      ...options.annotations,
      [LATEST_MESSAGE_ANNOTATION]: trimmed,
      ...(options.modelVisibility.oncePerSession ? { [ONCE_PER_SESSION_ANNOTATION]: true } : {}),
      ...(options.modelVisibility.requiredWhenVisible
        ? { [REQUIRED_WHEN_VISIBLE_ANNOTATION]: true }
        : {}),
    },
  };
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}
