import {
  type ButtonHTMLAttributes,
  createElement,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { ActionBar, SubmitButton } from './components.js';
import { type LayoutState, useRequestDisplayMode } from './hooks.js';

export type InlineCardProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly media?: ReactNode;
  readonly primaryAction?: ReactNode;
  readonly secondaryAction?: ReactNode;
};

export function InlineCard({
  title,
  description,
  media,
  primaryAction,
  secondaryAction,
  children,
  className,
  ...props
}: InlineCardProps) {
  return createElement(
    'article',
    { ...props, className: join('nsr-inline-card', className) },
    media === undefined ? null : createElement('div', { className: 'nsr-inline-media' }, media),
    title === undefined && description === undefined
      ? null
      : createElement(
          'header',
          { className: 'nsr-inline-header' },
          title === undefined
            ? null
            : createElement('h2', { className: 'nsr-inline-title' }, title),
          description === undefined
            ? null
            : createElement('p', { className: 'nsr-inline-description' }, description),
        ),
    children === undefined
      ? null
      : createElement('div', { className: 'nsr-inline-body' }, children),
    primaryAction === undefined && secondaryAction === undefined
      ? null
      : createElement(ActionBar, null, primaryAction, secondaryAction),
  );
}

export type InlineListItem = {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly action?: ReactNode;
};

export type InlineListProps = Omit<HTMLAttributes<HTMLUListElement>, 'children'> & {
  readonly items: readonly InlineListItem[];
};

export function InlineList({ items, className, ...props }: InlineListProps) {
  return createElement(
    'ul',
    { ...props, className: join('nsr-inline-list', className) },
    items.map((item) =>
      createElement(
        'li',
        { key: item.id, className: 'nsr-inline-list-item' },
        createElement(
          'span',
          { className: 'nsr-inline-list-copy' },
          createElement('strong', null, item.title),
          item.description === undefined ? null : createElement('small', null, item.description),
        ),
        item.meta === undefined
          ? null
          : createElement('span', { className: 'nsr-inline-meta' }, item.meta),
        item.action === undefined
          ? null
          : createElement('span', { className: 'nsr-inline-action' }, item.action),
      ),
    ),
  );
}

export type InlineCarouselProps<Item> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  readonly items: readonly Item[];
  readonly maxItems?: number;
  readonly children: (item: Item, index: number) => ReactNode;
};

export function InlineCarousel<Item>({
  items,
  maxItems = 8,
  children,
  className,
  ...props
}: InlineCarouselProps<Item>) {
  return createElement(
    'div',
    { ...props, className: join('nsr-inline-carousel', className) },
    items
      .slice(0, maxItems)
      .map((item, index) =>
        createElement(
          'div',
          { key: itemKey(item, index), className: 'nsr-inline-carousel-item' },
          children(item, index),
        ),
      ),
  );
}

export type FullscreenShellProps = HTMLAttributes<HTMLElement> & {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly footer?: ReactNode;
};

export function FullscreenShell({
  title,
  subtitle,
  toolbar,
  footer,
  children,
  className,
  ...props
}: FullscreenShellProps) {
  return createElement(
    'main',
    {
      ...props,
      className: join('nsr-fullscreen-shell', className),
      'data-display-mode': 'fullscreen',
    },
    title === undefined && subtitle === undefined && toolbar === undefined
      ? null
      : createElement(
          'header',
          { className: 'nsr-fullscreen-header' },
          createElement(
            'div',
            { className: 'nsr-title-block' },
            title === undefined ? null : createElement('h1', { className: 'nsr-title' }, title),
            subtitle === undefined
              ? null
              : createElement('p', { className: 'nsr-subtitle' }, subtitle),
          ),
          toolbar === undefined
            ? null
            : createElement('div', { className: 'nsr-toolbar' }, toolbar),
        ),
    createElement('section', { className: 'nsr-fullscreen-body' }, children),
    footer === undefined ? null : createElement('footer', { className: 'nsr-footer' }, footer),
  );
}

export type ExpandButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly mode?: LayoutState['displayMode'];
  readonly pendingLabel?: ReactNode;
};

export function ExpandButton({
  mode = 'fullscreen',
  pendingLabel,
  children,
  disabled,
  ...props
}: ExpandButtonProps) {
  const requestDisplayMode = useRequestDisplayMode();
  return createElement(
    SubmitButton,
    {
      ...props,
      type: props.type ?? 'button',
      disabled,
      pendingLabel,
      onClick: (event: unknown) => {
        props.onClick?.(event as never);
        void requestDisplayMode(mode).catch(() => undefined);
      },
    },
    children ?? (mode === 'fullscreen' ? 'Expand' : 'Change view'),
  );
}

function join(...parts: readonly (string | undefined | false)[]): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value.length === 0 ? undefined : value;
}

function itemKey(item: unknown, index: number): string {
  if (item !== null && typeof item === 'object' && 'id' in item) {
    const id = (item as { readonly id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return String(index);
}
