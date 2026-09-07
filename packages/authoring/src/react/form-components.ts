import {
  createElement,
  type FormEvent,
  type FormHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';
import { useFieldControlProps } from './field-context.js';

/**
 * Host-neutral form primitives. Native controls retain validation, reset, and accessibility behavior; the
 * kit adds portable submit intent, a consistent API, Field association, and semantic styling.
 */

function join(...parts: readonly (string | undefined | false)[]): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value.length === 0 ? undefined : value;
}

export type FormProps = Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'action' | 'method' | 'onSubmit' | 'target'
> & {
  /** Application submit intent; browser navigation is cancelled before this callback runs. */
  readonly onSubmit: () => void | Promise<void>;
};

type FormSubmitter = EventTarget & {
  readonly tagName: string;
  readonly type: string;
  readonly form: HTMLFormElement | null;
  readonly disabled: boolean;
  readonly formNoValidate: boolean;
  readonly parentElement: EventTarget | null;
};

type ElementLike = EventTarget & {
  readonly tagName?: unknown;
  readonly parentElement?: EventTarget | null;
};

type RuntimeForm = HTMLFormElement & {
  readonly elements: Iterable<EventTarget>;
  readonly noValidate: boolean;
  reportValidity(): boolean;
};

const SINGLE_LINE_INPUT_TYPES = new Set([
  'date',
  'datetime-local',
  'email',
  'month',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

function isElementLike(target: EventTarget | null): target is ElementLike {
  return target !== null && typeof (target as ElementLike).tagName === 'string';
}

function isSubmitter(control: EventTarget): control is FormSubmitter {
  if (!isElementLike(control)) return false;
  const candidate = control as Partial<FormSubmitter>;
  const tagName = candidate.tagName?.toLowerCase();
  return (
    (tagName === 'button' && candidate.type === 'submit') ||
    (tagName === 'input' && (candidate.type === 'submit' || candidate.type === 'image'))
  );
}

function submitterFromClick(
  target: EventTarget | null,
  form: HTMLFormElement,
): FormSubmitter | null {
  let control = target;
  while (isElementLike(control) && control !== form) {
    if (isSubmitter(control) && control.form === form && !control.disabled) return control;
    control = control.parentElement ?? null;
  }
  return null;
}

function defaultSubmitter(form: HTMLFormElement): FormSubmitter | null {
  for (const control of Array.from((form as RuntimeForm).elements)) {
    if (isSubmitter(control) && control.form === form && !control.disabled) return control;
  }
  return null;
}

function isPlainEnterIntent(event: ReactKeyboardEvent<HTMLFormElement>): boolean {
  if (
    event.key !== 'Enter' ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.repeat ||
    (event.nativeEvent as unknown as { readonly isComposing?: boolean }).isComposing
  ) {
    return false;
  }
  const control = event.target as Partial<FormSubmitter>;
  return (
    control.tagName?.toLowerCase() === 'input' &&
    control.form === event.currentTarget &&
    !control.disabled &&
    typeof control.type === 'string' &&
    SINGLE_LINE_INPUT_TYPES.has(control.type)
  );
}

function invokeFormIntent(
  form: HTMLFormElement,
  submitter: FormSubmitter | null,
  onSubmit: FormProps['onSubmit'],
): void {
  const runtimeForm = form as RuntimeForm;
  if (!runtimeForm.noValidate && !submitter?.formNoValidate && !runtimeForm.reportValidity())
    return;
  void onSubmit();
}

/** A host-neutral form that captures intent before sandboxed native submission can begin. */
export const Form = forwardRef<HTMLFormElement, FormProps>(function Form(
  { onSubmit, onClick, onKeyDown, ...props },
  ref,
) {
  return createElement('form', {
    ...props,
    ref,
    onClick: (event: ReactMouseEvent<HTMLFormElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      const submitter = submitterFromClick(event.target, event.currentTarget);
      if (submitter === null) return;
      event.preventDefault();
      invokeFormIntent(event.currentTarget, submitter, onSubmit);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLFormElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || !isPlainEnterIntent(event)) return;
      event.preventDefault();
      invokeFormIntent(event.currentTarget, defaultSubmitter(event.currentTarget), onSubmit);
    },
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nativeSubmitter = (
        event.nativeEvent as unknown as { readonly submitter?: EventTarget | null }
      ).submitter;
      invokeFormIntent(
        event.currentTarget,
        nativeSubmitter !== undefined && nativeSubmitter !== null && isSubmitter(nativeSubmitter)
          ? nativeSubmitter
          : null,
        onSubmit,
      );
    },
  });
});

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Renders the invalid affordance. Caller-provided ARIA and Field errors are still preserved. */
  readonly invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  return createElement('input', {
    ...props,
    ...field,
    ref,
    className: join('nsr-input', className),
    'aria-invalid': invalid === true ? true : field['aria-invalid'],
  });
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  return createElement('textarea', {
    ...props,
    ...field,
    ref,
    className: join('nsr-textarea', className),
    'aria-invalid': invalid === true ? true : field['aria-invalid'],
  });
});

export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  readonly options: readonly SelectOption[];
  /** Non-selectable prompt shown when no value is set. */
  readonly placeholder?: string;
  readonly invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, invalid, className, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  return createElement(
    'select',
    {
      ...props,
      ...field,
      ref,
      className: join('nsr-select', className),
      'aria-invalid': invalid === true ? true : field['aria-invalid'],
    },
    placeholder !== undefined
      ? createElement(
          'option',
          { key: '__placeholder', value: '', disabled: true, hidden: true },
          placeholder,
        )
      : null,
    options.map((option) =>
      createElement(
        'option',
        { key: option.value, value: option.value, disabled: option.disabled },
        option.label,
      ),
    ),
  );
});

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Inline label rendered beside the box. Omit to render a bare checkbox. */
  readonly label?: ReactNode;
  readonly onCheckedChange?: (checked: boolean) => void;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, onChange, onCheckedChange, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  const box = createElement('input', {
    ...props,
    ...field,
    ref,
    type: 'checkbox',
    className: join('nsr-checkbox', className),
    onChange: (event) => {
      onChange?.(event);
      onCheckedChange?.((event.currentTarget as unknown as { readonly checked: boolean }).checked);
    },
  });
  return label === undefined
    ? box
    : createElement('label', { className: 'nsr-check' }, box, createElement('span', null, label));
});

export type RadioOption = {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
};

export type RadioGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> & {
  readonly options: readonly RadioOption[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  /** Shared radio `name`; defaults to a stable generated id. */
  readonly name?: string;
  readonly direction?: 'row' | 'column';
  readonly disabled?: boolean;
  readonly required?: boolean;
};

export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    options,
    value,
    defaultValue,
    onValueChange,
    name,
    direction = 'column',
    disabled,
    required,
    className,
    ...props
  },
  ref,
) {
  const fallbackName = useId();
  const groupName = name ?? fallbackName;
  const field = useFieldControlProps({ ...props, required }, 'group');
  const controlled = value !== undefined;
  return createElement(
    'div',
    {
      ...props,
      ...field,
      ref,
      role: 'radiogroup',
      'aria-required': field.required || undefined,
      className: join('nsr-radio-group', direction === 'row' && 'nsr-radio-group-row', className),
    },
    options.map((option) =>
      createElement(
        'label',
        { key: option.value, className: 'nsr-radio' },
        createElement('input', {
          type: 'radio',
          name: groupName,
          value: option.value,
          ...(controlled
            ? { checked: value === option.value }
            : { defaultChecked: defaultValue === option.value }),
          required: field.required,
          disabled: disabled || option.disabled,
          onChange: () => {
            onValueChange?.(option.value);
          },
        }),
        createElement('span', null, option.label),
      ),
    ),
  );
});

export type SwitchProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'children' | 'onChange' | 'type'
> & {
  readonly onChange?: InputHTMLAttributes<HTMLInputElement>['onChange'];
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly label?: ReactNode;
};

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { onChange, onCheckedChange, label, className, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  const control = createElement('input', {
    ...props,
    ...field,
    ref,
    type: 'checkbox',
    role: 'switch',
    className: join('nsr-switch', className),
    onChange: (event) => {
      onChange?.(event);
      onCheckedChange?.((event.currentTarget as unknown as { readonly checked: boolean }).checked);
    },
  });
  return label === undefined
    ? control
    : createElement(
        'label',
        { className: 'nsr-switch-field' },
        control,
        createElement('span', null, label),
      );
});

export type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { className, ...props },
  ref,
) {
  const field = useFieldControlProps(props);
  return createElement('input', {
    ...props,
    ...field,
    ref,
    type: 'range',
    className: join('nsr-slider', className),
  });
});

export type SegmentedOption = {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
};

export type SegmentedControlProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'defaultValue' | 'onChange'
> & {
  readonly options: readonly SegmentedOption[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
};

/** Single-select value picker implemented with native radios for keyboard and form behavior. */
export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl(
    { options, value, defaultValue, onValueChange, name, disabled, required, className, ...props },
    ref,
  ) {
    const fallbackName = useId();
    const groupName = name ?? fallbackName;
    const field = useFieldControlProps({ ...props, required }, 'group');
    const controlled = value !== undefined;
    return createElement(
      'div',
      {
        ...props,
        ...field,
        ref,
        role: 'radiogroup',
        'aria-required': field.required || undefined,
        className: join('nsr-segmented', className),
      },
      options.map((option) =>
        createElement(
          'label',
          {
            key: option.value,
            className: 'nsr-segmented-option',
          },
          createElement('input', {
            type: 'radio',
            name: groupName,
            value: option.value,
            className: 'nsr-segmented-input',
            ...(controlled
              ? { checked: option.value === value }
              : { defaultChecked: option.value === defaultValue }),
            required: field.required,
            disabled: disabled || option.disabled,
            onChange: () => {
              onValueChange?.(option.value);
            },
          }),
          createElement('span', { className: 'nsr-segmented-label' }, option.label),
        ),
      ),
    );
  },
);
