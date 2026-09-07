import { createContext, useContext } from 'react';

export type FieldContextValue = {
  readonly controlId: string;
  readonly labelId: string;
  readonly detailId?: string;
  readonly errorId?: string;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly group: boolean;
};

export const FieldContext = createContext<FieldContextValue | undefined>(undefined);

type FieldAwareProps = {
  readonly id?: string | undefined;
  readonly required?: boolean | undefined;
  readonly 'aria-labelledby'?: string | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-errormessage'?: string | undefined;
  readonly 'aria-invalid'?: boolean | 'false' | 'true' | 'grammar' | 'spelling' | undefined;
};

export function useFieldControlProps(
  props: FieldAwareProps,
  kind: 'control' | 'group' = 'control',
) {
  const field = useContext(FieldContext);
  const activeField = field?.group && kind === 'control' ? undefined : field;
  return {
    id: props.id ?? activeField?.controlId,
    required: props.required ?? activeField?.required,
    'aria-labelledby': mergeTokens(props['aria-labelledby'], activeField?.labelId),
    'aria-describedby': mergeTokens(
      props['aria-describedby'],
      activeField?.detailId,
      activeField?.errorId,
    ),
    'aria-errormessage': mergeTokens(props['aria-errormessage'], activeField?.errorId),
    'aria-invalid': props['aria-invalid'] ?? (activeField?.invalid ? true : undefined),
  };
}

function mergeTokens(...values: readonly (string | undefined)[]): string | undefined {
  const tokens = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  const unique = [...new Set(tokens)];
  return unique.length === 0 ? undefined : unique.join(' ');
}
