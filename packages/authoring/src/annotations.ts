export const annotations = {
  readOnly(options: { readonly openWorld?: boolean; readonly idempotent?: boolean } = {}) {
    return compactAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: options.idempotent ?? true,
      openWorldHint: options.openWorld ?? false,
    });
  },
  action(
    options: {
      readonly destructive?: boolean;
      readonly openWorld?: boolean;
      /** Suspend for runtime-enforced approval only when explicitly true. */
      readonly confirm?: boolean;
    } = {},
  ) {
    return compactAnnotations({
      readOnlyHint: false,
      destructiveHint: options.destructive ?? false,
      openWorldHint: options.openWorld ?? true,
      confirm: options.confirm,
    });
  },
  localAction(
    options: {
      readonly destructive?: boolean;
      /** Suspend for runtime-enforced approval only when explicitly true. */
      readonly confirm?: boolean;
    } = {},
  ) {
    return compactAnnotations({
      readOnlyHint: false,
      destructiveHint: options.destructive ?? true,
      idempotentHint: false,
      openWorldHint: false,
      confirm: options.confirm,
    });
  },
  openAction(
    options: {
      readonly destructive?: boolean;
      /** Suspend for runtime-enforced approval only when explicitly true. */
      readonly confirm?: boolean;
    } = {},
  ) {
    return compactAnnotations({
      readOnlyHint: false,
      destructiveHint: options.destructive ?? false,
      idempotentHint: false,
      openWorldHint: true,
      confirm: options.confirm,
    });
  },
} as const;

function compactAnnotations<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
