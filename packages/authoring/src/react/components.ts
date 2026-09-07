import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  type ButtonHTMLAttributes,
  cloneElement,
  createElement,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  useId,
  useRef,
} from 'react';
import type { AppFlow } from './app-flow.js';
import { FieldContext, type FieldContextValue } from './field-context.js';
import type { HandoffController } from './handoff.js';
import { type CallToolState, type LayoutState, useLayout } from './hooks.js';
import { Feedback } from './semantic-components.js';

export type AppShellProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly icon?: ReactNode;
  readonly badge?: ReactNode;
  readonly footer?: ReactNode;
  readonly displayMode?: LayoutState['displayMode'] | 'auto';
};

export function AppShell({
  title,
  subtitle,
  icon,
  badge,
  footer,
  displayMode = 'inline',
  children,
  className,
  ...props
}: AppShellProps) {
  const layout = useLayout();
  const resolvedDisplayMode = displayMode === 'auto' ? layout.displayMode : displayMode;
  const content =
    title || subtitle || icon || badge || footer !== undefined
      ? [
          title || subtitle || icon || badge
            ? createElement(ShellHeader, { key: 'header', title, subtitle, icon, badge })
            : null,
          children,
          footer === undefined
            ? null
            : createElement('footer', { key: 'footer', className: 'nsr-footer' }, footer),
        ]
      : children;
  return createElement(
    'main',
    {
      ...props,
      className: join('nsr-shell', `nsr-shell-${resolvedDisplayMode}`, className),
      'data-display-mode': resolvedDisplayMode,
    },
    createElement(
      'section',
      {
        className:
          resolvedDisplayMode === 'fullscreen'
            ? 'nsr-shell-surface'
            : 'nsr-card nsr-card-wide nsr-shell-surface',
      },
      content,
    ),
  );
}

export type ShellHeaderProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly icon?: ReactNode;
  readonly badge?: ReactNode;
};

export function ShellHeader({
  title,
  subtitle,
  icon,
  badge,
  className,
  ...props
}: ShellHeaderProps) {
  return createElement(
    'header',
    { ...props, className: join('nsr-header', className) },
    icon === undefined
      ? null
      : createElement('span', { className: 'nsr-icon', 'aria-hidden': true }, icon),
    createElement(
      'div',
      { className: 'nsr-title-block' },
      title === undefined ? null : createElement('h1', { className: 'nsr-title' }, title),
      subtitle === undefined ? null : createElement('p', { className: 'nsr-subtitle' }, subtitle),
    ),
    badge === undefined ? null : createElement('span', { className: 'nsr-chip' }, badge),
  );
}

export type ShellNavProps<ViewName extends string = string> = HTMLAttributes<HTMLElement> & {
  readonly activeView: ViewName;
  readonly items: readonly { readonly view: ViewName; readonly label: ReactNode }[];
  readonly onNavigate: (view: ViewName) => void;
};

export function ShellNav<ViewName extends string>({
  activeView,
  items,
  onNavigate,
  className,
  ...props
}: ShellNavProps<ViewName>) {
  return createElement(
    'nav',
    { ...props, className: join('nsr-tabs', className) },
    items.map((item) =>
      createElement(
        'button',
        {
          key: item.view,
          className: 'nsr-tab',
          type: 'button',
          'aria-current': activeView === item.view ? 'step' : undefined,
          onClick: () => onNavigate(item.view),
        },
        item.label,
      ),
    ),
  );
}

export type ViewStackProps<ViewName extends string = string> = HTMLAttributes<HTMLDivElement> & {
  readonly flow: Pick<AppFlow<ViewName>, 'activeView'>;
};

export function ViewStack<ViewName extends string>({
  flow,
  children,
  className,
  ...props
}: ViewStackProps<ViewName>) {
  return createElement(
    'div',
    { ...props, className: join('nsr-view-stack', className) },
    mapChildren(children, (child) => {
      if (!isValidElement<ViewProps<ViewName>>(child)) return child;
      return child.props.name === flow.activeView ? child : null;
    }),
  );
}

export type ViewProps<ViewName extends string = string> = HTMLAttributes<HTMLElement> & {
  readonly name: ViewName;
};

export function View<ViewName extends string>({
  name,
  children,
  className,
  ...props
}: ViewProps<ViewName>) {
  return createElement(
    'section',
    { ...props, className: join('nsr-view', className), 'data-view': name },
    children,
  );
}

export type ViewNavProps<ViewName extends string = string> = HTMLAttributes<HTMLElement> & {
  readonly activeView: ViewName;
  readonly items: readonly { readonly view: ViewName; readonly label: ReactNode }[];
  readonly onNavigate: (view: ViewName) => void;
  readonly variant?: 'tabs' | 'steps' | 'segmented';
};

export function ViewNav<ViewName extends string>({
  activeView,
  items,
  onNavigate,
  variant = 'tabs',
  className,
  ...props
}: ViewNavProps<ViewName>) {
  return createElement(
    'nav',
    { ...props, className: join('nsr-view-nav', `nsr-view-nav-${variant}`, className) },
    items.map((item, index) =>
      createElement(
        'button',
        {
          key: item.view,
          className: 'nsr-view-nav-item',
          type: 'button',
          'aria-current': activeView === item.view ? 'page' : undefined,
          'data-step': variant === 'steps' ? String(index + 1) : undefined,
          onClick: () => onNavigate(item.view),
        },
        item.label,
      ),
    ),
  );
}

type OverlayBaseProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
};

export type OverlayProps = OverlayBaseProps &
  (
    | { readonly mode?: 'modal' | 'sheet'; readonly title: ReactNode }
    | { readonly mode: 'detail'; readonly title?: ReactNode }
  );

export function Overlay({
  open,
  defaultOpen,
  onOpenChange,
  mode = 'modal',
  title,
  description,
  actions,
  children,
  className,
  ...props
}: OverlayProps) {
  const restoreFocusRef = useRef<{ focus(): void } | undefined>(undefined);
  const generatedId = `nsr-overlay-${useId().replace(/:/g, '')}`;
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;
  const content = createElement(
    'header',
    { className: 'nsr-overlay-header' },
    createElement(
      'div',
      { className: 'nsr-title-block' },
      title === undefined
        ? null
        : mode === 'detail'
          ? createElement('h2', { id: titleId, className: 'nsr-overlay-title' }, title)
          : createElement(
              DialogPrimitive.Title,
              { id: titleId, className: 'nsr-overlay-title' },
              title,
            ),
      description === undefined
        ? null
        : mode === 'detail'
          ? createElement(
              'p',
              { id: descriptionId, className: 'nsr-overlay-description' },
              description,
            )
          : createElement(
              DialogPrimitive.Description,
              { id: descriptionId, className: 'nsr-overlay-description' },
              description,
            ),
    ),
    actions === undefined
      ? null
      : createElement('div', { className: 'nsr-overlay-actions' }, actions),
  );

  if (mode === 'detail') {
    const visible = open ?? defaultOpen ?? false;
    if (!visible) return null;
    return createElement(
      'section',
      {
        ...props,
        className: join('nsr-overlay', 'nsr-overlay-detail', className),
        role: title === undefined ? undefined : 'region',
        'aria-labelledby': title === undefined ? undefined : titleId,
        'aria-describedby': description === undefined ? undefined : descriptionId,
      },
      title === undefined && description === undefined && actions === undefined ? null : content,
      createElement('div', { className: 'nsr-overlay-body' }, children),
    );
  }

  return createElement(
    DialogPrimitive.Root,
    {
      ...(open === undefined ? {} : { open }),
      ...(defaultOpen === undefined ? {} : { defaultOpen }),
      ...(onOpenChange === undefined ? {} : { onOpenChange }),
    },
    createElement(
      DialogPrimitive.Portal,
      null,
      createElement(DialogPrimitive.Overlay, { className: 'nsr-overlay-backdrop' }),
      createElement(
        DialogPrimitive.Content,
        {
          ...props,
          className: join('nsr-portal-content', 'nsr-overlay', `nsr-overlay-${mode}`, className),
          'aria-modal': true,
          'aria-labelledby': titleId,
          'aria-describedby': description === undefined ? undefined : descriptionId,
          onOpenAutoFocus: () => {
            restoreFocusRef.current = activeElement();
          },
          onCloseAutoFocus: (event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus();
            restoreFocusRef.current = undefined;
          },
        },
        content,
        createElement('div', { className: 'nsr-overlay-body' }, children),
        createElement(
          DialogPrimitive.Close,
          { type: 'button', className: 'nsr-overlay-close', 'aria-label': 'Close' },
          '×',
        ),
      ),
    ),
  );
}

export type ActionBarProps = HTMLAttributes<HTMLDivElement>;

export function ActionBar({ children, className, ...props }: ActionBarProps) {
  return createElement('div', { ...props, className: join('nsr-actions', className) }, children);
}

export type AsyncBoundaryProps = HTMLAttributes<HTMLDivElement> & {
  readonly state?: Pick<CallToolState, 'status' | 'error'>;
  readonly loading?: ReactNode;
  readonly error?: ReactNode | ((error: Error) => ReactNode);
  readonly empty?: ReactNode;
  readonly isEmpty?: boolean;
};

export function AsyncBoundary({
  state,
  loading,
  error,
  empty,
  isEmpty = false,
  children,
  className,
  ...props
}: AsyncBoundaryProps) {
  if (state?.status === 'pending') {
    return createElement(Feedback, { className, status: 'loading' }, loading ?? null);
  }
  if (state?.status === 'error') {
    const content =
      typeof error === 'function' ? error(state.error ?? new Error('Request failed')) : error;
    return createElement(Feedback, {
      className,
      status: 'error',
      description: content ?? state.error?.message ?? 'Request failed',
    });
  }
  if (isEmpty) return createElement(Feedback, { className, status: 'empty' }, empty ?? null);
  return createElement(
    'div',
    { ...props, className: join('nsr-async', className), 'aria-live': 'polite' },
    children,
  );
}

export type EmptyStateProps = HTMLAttributes<HTMLDivElement>;
export function EmptyState({ children, className, ...props }: EmptyStateProps) {
  return createElement(
    'div',
    { ...props, className: join('nsr-empty', className), role: 'status' },
    children,
  );
}

export type ErrorStateProps = HTMLAttributes<HTMLDivElement>;
export function ErrorState({ children, className, ...props }: ErrorStateProps) {
  return createElement(
    'div',
    { ...props, className: join('nsr-error', className), role: 'alert' },
    children,
  );
}

export type LoadingStateProps = HTMLAttributes<HTMLDivElement>;
export function LoadingState({ children, className, ...props }: LoadingStateProps) {
  return createElement(
    'div',
    { ...props, className: join('nsr-loading', className), role: 'status' },
    children,
  );
}

export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  readonly tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
};

export function StatusBadge({ tone = 'neutral', children, className, ...props }: StatusBadgeProps) {
  return createElement(
    'span',
    { ...props, className: join('nsr-badge', `nsr-badge-${tone}`, className) },
    children,
  );
}

export type DataListProps = HTMLAttributes<HTMLDivElement>;
export function DataList({ children, className, ...props }: DataListProps) {
  return createElement('div', { ...props, className: join('nsr-data-list', className) }, children);
}

export type DataCardProps = (
  | HTMLAttributes<HTMLElement>
  | ButtonHTMLAttributes<HTMLButtonElement>
) & {
  readonly as?: 'article' | 'button' | 'div';
};
export function DataCard({ as = 'div', children, className, ...props }: DataCardProps) {
  return createElement(as, { ...props, className: join('nsr-data-card', className) }, children);
}

export type QuantityStepperProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly decrementLabel?: string;
  readonly incrementLabel?: string;
};

export function QuantityStepper({
  value,
  min = 0,
  max,
  step = 1,
  onChange,
  decrementLabel = 'Decrease',
  incrementLabel = 'Increase',
  className,
  ...props
}: QuantityStepperProps) {
  const nextDown = Math.max(min, value - step);
  const nextUp = max === undefined ? value + step : Math.min(max, value + step);
  return createElement(
    'div',
    { ...props, className: join('nsr-stepper', className) },
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': decrementLabel,
        disabled: value <= min,
        onClick: () => onChange(nextDown),
      },
      '-',
    ),
    createElement('span', { className: 'nsr-stepper-value' }, String(value)),
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': incrementLabel,
        disabled: max !== undefined && value >= max,
        onClick: () => onChange(nextUp),
      },
      '+',
    ),
  );
}

export type ChoiceGroupProps<Value extends string = string> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange'
> & {
  readonly values: readonly Value[];
  readonly selected: readonly Value[];
  readonly onChange: (selected: readonly Value[]) => void;
  readonly labelFor?: (value: Value) => ReactNode;
};

export function ChoiceGroup<Value extends string>({
  values,
  selected,
  onChange,
  labelFor = (value) => value,
  className,
  ...props
}: ChoiceGroupProps<Value>) {
  return createElement(
    'div',
    { ...props, className: join('nsr-choice-group', className) },
    values.map((value) => {
      const checked = selected.includes(value);
      return createElement(
        'label',
        { key: value, className: 'nsr-choice' },
        createElement('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => {
            const checked = (event.currentTarget as unknown as { readonly checked: boolean })
              .checked;
            onChange(checked ? [...selected, value] : selected.filter((entry) => entry !== value));
          },
        }),
        createElement('span', null, labelFor(value)),
      );
    }),
  );
}

export type FieldProps = HTMLAttributes<HTMLElement> & {
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  /** Render a semantic fieldset/legend for radio, checkbox, or segmented groups. */
  readonly group?: boolean;
  /** Stable id for the associated control. Generated when omitted. */
  readonly controlId?: string;
};

export function Field({
  label,
  detail,
  error,
  required = false,
  group = false,
  controlId,
  children,
  className,
  ...props
}: FieldProps) {
  const generatedId = useId();
  const childId = isValidElement<{ readonly id?: string }>(children)
    ? children.props.id
    : undefined;
  const baseId = controlId ?? childId ?? `nsr-field-${generatedId.replace(/:/g, '')}`;
  const labelId = `${baseId}-label`;
  const detailId = detail === undefined ? undefined : `${baseId}-detail`;
  const errorId = error === undefined ? undefined : `${baseId}-error`;
  const context: FieldContextValue = {
    controlId: baseId,
    labelId,
    ...(detailId === undefined ? {} : { detailId }),
    ...(errorId === undefined ? {} : { errorId }),
    invalid: error !== undefined,
    required,
    group,
  };
  const labelNode = group
    ? createElement(
        'legend',
        { id: labelId, className: 'nsr-field-label' },
        label,
        required
          ? createElement('span', { className: 'nsr-field-required', 'aria-hidden': true }, ' *')
          : null,
      )
    : createElement(
        'label',
        { id: labelId, htmlFor: baseId, className: 'nsr-field-label' },
        label,
        required
          ? createElement('span', { className: 'nsr-field-required', 'aria-hidden': true }, ' *')
          : null,
      );
  const associatedChildren = group
    ? children
    : isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, {
          id: (children.props.id as string | undefined) ?? baseId,
          required: (children.props.required as boolean | undefined) ?? required,
          'aria-labelledby': mergeTokens(
            children.props['aria-labelledby'] as string | undefined,
            labelId,
          ),
          'aria-describedby': mergeTokens(
            children.props['aria-describedby'] as string | undefined,
            detailId,
            errorId,
          ),
          'aria-errormessage': mergeTokens(
            children.props['aria-errormessage'] as string | undefined,
            errorId,
          ),
          'aria-invalid':
            (children.props['aria-invalid'] as string | boolean | undefined) ??
            (error === undefined ? undefined : true),
        })
      : children;
  return createElement(
    FieldContext.Provider,
    { value: context },
    createElement(
      group ? 'fieldset' : 'div',
      {
        ...props,
        className: join('nsr-field', className),
        ...(group
          ? {
              'aria-describedby': mergeTokens(
                props['aria-describedby'] as string | undefined,
                detailId,
                errorId,
              ),
              'aria-errormessage': mergeTokens(
                props['aria-errormessage'] as string | undefined,
                errorId,
              ),
              'aria-invalid': props['aria-invalid'] ?? (error === undefined ? undefined : true),
              'aria-required': required || undefined,
            }
          : {}),
      },
      labelNode,
      associatedChildren,
      detail === undefined
        ? null
        : createElement('span', { id: detailId, className: 'nsr-field-detail' }, detail),
      error === undefined
        ? null
        : createElement(
            'span',
            { id: errorId, className: 'nsr-field-error', role: 'alert' },
            error,
          ),
    ),
  );
}

export type SubmitButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly pending?: boolean;
  readonly pendingLabel?: ReactNode;
};

export function SubmitButton({
  pending = false,
  pendingLabel,
  children,
  disabled,
  ...props
}: SubmitButtonProps) {
  return createElement(
    'button',
    {
      ...props,
      type: props.type ?? 'submit',
      disabled: disabled || pending,
      'aria-busy': pending || undefined,
    },
    pending ? (pendingLabel ?? children) : children,
  );
}

export type HandoffButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  readonly handoff: Pick<HandoffController, 'open' | 'status'>;
  readonly target: string | { readonly url?: string; readonly checkoutUrl?: string };
  readonly pendingLabel?: ReactNode;
};

export function HandoffButton({
  handoff,
  target,
  pendingLabel,
  children,
  disabled,
  ...props
}: HandoffButtonProps) {
  const pending = handoff.status === 'opening';
  return createElement(SubmitButton, {
    ...props,
    type: props.type ?? 'button',
    disabled: disabled || pending,
    pending,
    pendingLabel,
    onClick: () => {
      void handoff.open(target).catch(() => undefined);
    },
    children,
  });
}

function join(...parts: readonly (string | undefined | false)[]): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value.length === 0 ? undefined : value;
}

function mergeTokens(...values: readonly (string | undefined)[]): string | undefined {
  const tokens = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  const unique = [...new Set(tokens)];
  return unique.length === 0 ? undefined : unique.join(' ');
}

function activeElement(): { focus(): void } | undefined {
  const document = (globalThis as { document?: { activeElement?: unknown } }).document;
  const element = document?.activeElement as { focus?: () => void } | undefined;
  return typeof element?.focus === 'function' ? { focus: () => element.focus?.() } : undefined;
}

function mapChildren(children: ReactNode, mapper: (child: ReactNode) => ReactNode): ReactNode {
  return Array.isArray(children) ? children.map(mapper) : mapper(children);
}
