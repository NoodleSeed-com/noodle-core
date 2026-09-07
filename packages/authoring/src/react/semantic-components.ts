import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  createElement,
  type HTMLAttributes,
  type ReactNode,
  useId,
} from 'react';
import type { LayoutState } from './hooks.js';
import { useLayout } from './hooks.js';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export type FrameProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly icon?: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly displayMode?: LayoutState['displayMode'] | 'auto';
};

export function Frame({
  title,
  subtitle,
  icon,
  status,
  actions,
  footer,
  displayMode = 'auto',
  children,
  className,
  style,
  lang,
  ...props
}: FrameProps) {
  const layout = useLayout();
  const resolvedDisplayMode = displayMode === 'auto' ? layout.displayMode : displayMode;
  const safeArea = layout.safeAreaInsets;
  const resolvedStyle =
    safeArea === undefined
      ? style
      : ({
          ...style,
          '--nsr-safe-area-top': `${safeArea.top}px`,
          '--nsr-safe-area-right': `${safeArea.right}px`,
          '--nsr-safe-area-bottom': `${safeArea.bottom}px`,
          '--nsr-safe-area-left': `${safeArea.left}px`,
        } as typeof style);
  return createElement(
    'main',
    {
      ...props,
      lang: lang ?? layout.locale,
      style: resolvedStyle,
      className: join('nsr-frame', `nsr-frame-${resolvedDisplayMode}`, className),
      'data-display-mode': resolvedDisplayMode,
      'data-platform': layout.platform,
      'data-touch': layout.deviceCapabilities?.touch || undefined,
    },
    createElement(
      'section',
      { className: 'nsr-frame-surface' },
      title === undefined &&
        subtitle === undefined &&
        icon === undefined &&
        status === undefined &&
        actions === undefined
        ? null
        : createElement(
            'header',
            { className: 'nsr-frame-header' },
            icon === undefined
              ? null
              : createElement('span', { className: 'nsr-frame-icon', 'aria-hidden': true }, icon),
            createElement(
              'div',
              { className: 'nsr-title-block' },
              title === undefined ? null : createElement('h1', { className: 'nsr-title' }, title),
              subtitle === undefined
                ? null
                : createElement('p', { className: 'nsr-subtitle' }, subtitle),
            ),
            status === undefined && actions === undefined
              ? null
              : createElement(
                  'div',
                  { className: 'nsr-frame-meta' },
                  status,
                  actions === undefined
                    ? null
                    : createElement('div', { className: 'nsr-actions' }, actions),
                ),
          ),
      createElement('div', { className: 'nsr-frame-body' }, children),
      footer === undefined
        ? null
        : createElement('footer', { className: 'nsr-frame-footer' }, footer),
    ),
  );
}

export type RegionProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly tone?: Tone;
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
};

export function Region({
  title,
  description,
  status,
  actions,
  tone = 'neutral',
  headingLevel = 2,
  children,
  className,
  ...props
}: RegionProps) {
  const headingId = `nsr-region-${useId().replace(/:/g, '')}-title`;
  return createElement(
    'section',
    {
      ...props,
      className: join('nsr-region', `nsr-region-${tone}`, className),
      'aria-labelledby': props['aria-labelledby'] ?? (title === undefined ? undefined : headingId),
    },
    title === undefined &&
      description === undefined &&
      status === undefined &&
      actions === undefined
      ? null
      : createElement(
          'header',
          { className: 'nsr-region-header' },
          createElement(
            'div',
            { className: 'nsr-title-block' },
            title === undefined
              ? null
              : createElement(
                  `h${headingLevel}`,
                  { id: headingId, className: 'nsr-region-title' },
                  title,
                ),
            description === undefined
              ? null
              : createElement('p', { className: 'nsr-region-description' }, description),
          ),
          status === undefined && actions === undefined
            ? null
            : createElement('div', { className: 'nsr-region-meta' }, status, actions),
        ),
    createElement('div', { className: 'nsr-region-body' }, children),
  );
}

export type FlowProps = HTMLAttributes<HTMLDivElement> & {
  readonly variant?: 'stack' | 'cluster' | 'split' | 'grid' | 'sidebar';
  readonly density?: 'compact' | 'comfortable';
};

export function Flow({
  variant = 'stack',
  density = 'comfortable',
  children,
  className,
  ...props
}: FlowProps) {
  return createElement(
    'div',
    {
      ...props,
      className: join('nsr-flow', `nsr-flow-${variant}`, `nsr-flow-${density}`, className),
    },
    children,
  );
}

export type CollectionProps = HTMLAttributes<HTMLDivElement> & {
  readonly variant?: 'list' | 'grid' | 'table';
  readonly selectionMode?: 'none' | 'single' | 'multiple';
};

export type CollectionItemProps = (
  | HTMLAttributes<HTMLElement>
  | ButtonHTMLAttributes<HTMLButtonElement>
) & {
  readonly as?: 'article' | 'button' | 'div';
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly badge?: ReactNode;
  readonly selected?: boolean;
  readonly tone?: Tone;
};

function CollectionRoot({
  variant = 'list',
  selectionMode = 'none',
  children,
  className,
  ...props
}: CollectionProps) {
  return createElement(
    'div',
    {
      ...props,
      className: join('nsr-collection', `nsr-collection-${variant}`, className),
      'data-selection-mode': selectionMode,
    },
    children,
  );
}

function CollectionItem({
  as = 'article',
  title,
  description,
  meta,
  badge,
  selected = false,
  tone = 'neutral',
  children,
  className,
  ...props
}: CollectionItemProps) {
  return createElement(
    as,
    {
      ...props,
      className: join(
        'nsr-collection-item',
        `nsr-collection-item-${tone}`,
        selected && 'nsr-collection-item-selected',
        className,
      ),
      'data-selected': selected || undefined,
    },
    createElement(
      'span',
      { className: 'nsr-collection-copy' },
      title === undefined
        ? null
        : createElement('strong', { className: 'nsr-collection-title' }, title),
      description === undefined
        ? null
        : createElement('small', { className: 'nsr-collection-description' }, description),
      children === undefined
        ? null
        : createElement('span', { className: 'nsr-collection-body' }, children),
    ),
    meta === undefined ? null : createElement('span', { className: 'nsr-collection-meta' }, meta),
    badge === undefined
      ? null
      : createElement('span', { className: 'nsr-collection-badge' }, badge),
  );
}

export const Collection = Object.assign(CollectionRoot, { Item: CollectionItem });

export type FeedbackProps = HTMLAttributes<HTMLDivElement> & {
  readonly status:
    | 'loading'
    | 'empty'
    | 'error'
    | 'success'
    | 'partial'
    | 'permission-denied'
    | 'unsupported';
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
};

export function Feedback({
  status,
  title,
  description,
  action,
  children,
  className,
  ...props
}: FeedbackProps) {
  const role = status === 'error' || status === 'permission-denied' ? 'alert' : 'status';
  const defaultTitle =
    title ??
    {
      loading: 'Loading',
      empty: 'No results',
      error: 'Request failed',
      success: 'Complete',
      partial: 'Partial results',
      'permission-denied': 'Permission needed',
      unsupported: 'Unsupported here',
    }[status];
  return createElement(
    'div',
    {
      ...props,
      className: join('nsr-feedback', `nsr-feedback-${status}`, className),
      role,
      'aria-busy': status === 'loading' || undefined,
    },
    createElement(
      'div',
      { className: 'nsr-feedback-copy' },
      createElement('strong', { className: 'nsr-feedback-title' }, defaultTitle),
      description === undefined
        ? null
        : createElement('p', { className: 'nsr-feedback-description' }, description),
      children === undefined
        ? null
        : createElement('div', { className: 'nsr-feedback-body' }, children),
    ),
    action === undefined
      ? null
      : createElement('div', { className: 'nsr-feedback-action' }, action),
  );
}

export type FactProps = HTMLAttributes<HTMLDListElement> & {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly detail?: ReactNode;
  readonly trend?: ReactNode;
  readonly tone?: Tone;
};

export function Fact({
  label,
  value,
  detail,
  trend,
  tone = 'neutral',
  className,
  ...props
}: FactProps) {
  return createElement(
    'dl',
    { ...props, className: join('nsr-fact', `nsr-fact-${tone}`, className) },
    createElement('dt', { className: 'nsr-fact-label' }, label),
    createElement(
      'dd',
      { className: 'nsr-fact-value' },
      createElement('span', { className: 'nsr-fact-value-text' }, value),
      detail === undefined
        ? null
        : createElement('small', { className: 'nsr-fact-detail' }, detail),
      trend === undefined ? null : createElement('small', { className: 'nsr-fact-trend' }, trend),
    ),
  );
}

export type ActionProps = (
  | ButtonHTMLAttributes<HTMLButtonElement>
  | AnchorHTMLAttributes<HTMLAnchorElement>
) & {
  readonly as?: 'button' | 'a';
  readonly variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  readonly pending?: boolean;
  readonly pendingLabel?: ReactNode;
  readonly external?: boolean;
  readonly disabled?: boolean;
};

export function Action({
  as = 'button',
  variant = 'secondary',
  pending = false,
  pendingLabel,
  external = false,
  disabled,
  children,
  className,
  ...props
}: ActionProps) {
  const isButton = as === 'button';
  const blocked = disabled || pending;
  const anchorProps = props as AnchorHTMLAttributes<HTMLAnchorElement>;
  return createElement(
    as,
    {
      ...props,
      className: join(
        'nsr-action',
        `nsr-action-${variant}`,
        external && 'nsr-action-external',
        className,
      ),
      ...(isButton
        ? { type: (props as ButtonHTMLAttributes<HTMLButtonElement>).type ?? 'button' }
        : {
            href: blocked ? undefined : anchorProps.href,
            target: external ? (anchorProps.target ?? '_blank') : anchorProps.target,
            rel: external
              ? mergeTokens(anchorProps.rel, 'noopener', 'noreferrer')
              : anchorProps.rel,
            'aria-disabled': blocked || undefined,
            tabIndex: blocked ? -1 : anchorProps.tabIndex,
            onClick: blocked
              ? (event: { preventDefault(): void; stopPropagation(): void }) => {
                  event.preventDefault();
                  event.stopPropagation();
                }
              : anchorProps.onClick,
          }),
      'aria-busy': pending || undefined,
      disabled: isButton ? blocked : undefined,
    },
    pending ? (pendingLabel ?? children) : children,
  );
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
