import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ComponentType, createElement, type ReactElement, type ReactNode, useId } from 'react';

/**
 * Host-neutral overlays. Radix supplies audited focus, keyboard, dismissal, and collision behavior;
 * Noodle owns the public API, class hooks, tokens, and MCP-host adaptation.
 */

function join(...parts: readonly (string | undefined | false)[]): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value.length === 0 ? undefined : value;
}

const TooltipProvider = TooltipPrimitive.Provider as ComponentType<{
  readonly delayDuration?: number;
  readonly skipDelayDuration?: number;
  readonly children?: ReactNode;
}>;

export type SpinnerProps = {
  readonly size?: number;
  readonly label?: string;
  readonly className?: string;
};

export function Spinner({ size = 18, label = 'Loading', className }: SpinnerProps) {
  return createElement('span', {
    className: join('nsr-spinner', className),
    role: 'status',
    'aria-label': label,
    style: { width: size, height: size },
  });
}

export type TooltipProps = {
  readonly content: ReactNode;
  /** A single focusable element; semantics and refs are applied to this actual trigger. */
  readonly children: ReactElement;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly className?: string;
};

export function Tooltip({
  content,
  children,
  open,
  defaultOpen,
  onOpenChange,
  side = 'top',
  className,
}: TooltipProps) {
  const tooltip = createElement(
    TooltipPrimitive.Root,
    {
      ...(open === undefined ? {} : { open }),
      ...(defaultOpen === undefined ? {} : { defaultOpen }),
      ...(onOpenChange === undefined ? {} : { onOpenChange }),
    },
    createElement(TooltipPrimitive.Trigger, { asChild: true }, children),
    createElement(
      TooltipPrimitive.Portal,
      null,
      createElement(
        TooltipPrimitive.Content,
        {
          className: join('nsr-portal-content', 'nsr-tooltip-bubble', className),
          side,
          sideOffset: 6,
          collisionPadding: 8,
        },
        content,
        createElement(TooltipPrimitive.Arrow, { className: 'nsr-tooltip-arrow' }),
      ),
    ),
  );
  return createElement(
    TooltipProvider,
    {
      delayDuration: 0,
      skipDelayDuration: 0,
    },
    tooltip,
  );
}

export type PopoverProps = {
  /** Content of the rendered trigger button; avoids nested interactive elements. */
  readonly trigger: ReactNode;
  readonly triggerLabel?: string;
  readonly children?: ReactNode;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly className?: string;
};

export function Popover({
  trigger,
  triggerLabel,
  children,
  open,
  defaultOpen,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  className,
}: PopoverProps) {
  const triggerId = `nsr-popover-${useId().replace(/:/g, '')}`;
  return createElement(
    PopoverPrimitive.Root,
    {
      ...(open === undefined ? {} : { open }),
      ...(defaultOpen === undefined ? {} : { defaultOpen }),
      ...(onOpenChange === undefined ? {} : { onOpenChange }),
    },
    createElement(
      PopoverPrimitive.Trigger,
      {
        id: triggerId,
        type: 'button',
        className: 'nsr-popover-trigger',
        ...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel }),
      },
      trigger,
    ),
    createElement(
      PopoverPrimitive.Portal,
      null,
      createElement(
        PopoverPrimitive.Content,
        {
          className: join('nsr-portal-content', 'nsr-popover-panel', className),
          align,
          side,
          sideOffset: 6,
          collisionPadding: 8,
          'aria-labelledby': triggerId,
        },
        children,
      ),
    ),
  );
}

export type MenuAction = {
  readonly label: ReactNode;
  /** Plain text used for typeahead when `label` is not a string. */
  readonly textValue?: string;
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
};

export type MenuItem = MenuAction | 'separator';

export type MenuProps = {
  readonly trigger: ReactNode;
  readonly triggerLabel?: string;
  readonly items: readonly MenuItem[];
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly className?: string;
};

export function Menu({
  trigger,
  triggerLabel,
  items,
  open,
  defaultOpen,
  onOpenChange,
  align = 'start',
  side = 'bottom',
  className,
}: MenuProps) {
  return createElement(
    DropdownMenuPrimitive.Root,
    {
      ...(open === undefined ? {} : { open }),
      ...(defaultOpen === undefined ? {} : { defaultOpen }),
      ...(onOpenChange === undefined ? {} : { onOpenChange }),
    },
    createElement(
      DropdownMenuPrimitive.Trigger,
      {
        type: 'button',
        className: 'nsr-menu-trigger',
        ...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel }),
      },
      trigger,
    ),
    createElement(
      DropdownMenuPrimitive.Portal,
      null,
      createElement(
        DropdownMenuPrimitive.Content,
        {
          className: join('nsr-portal-content', 'nsr-popover-panel', 'nsr-menu-content', className),
          align,
          side,
          sideOffset: 6,
          collisionPadding: 8,
        },
        items.map((item, index) =>
          item === 'separator'
            ? createElement(DropdownMenuPrimitive.Separator, {
                key: `sep-${index}`,
                className: 'nsr-menu-sep',
              })
            : createElement(
                DropdownMenuPrimitive.Item,
                {
                  key: `item-${index}`,
                  className: join('nsr-menu-item', item.danger && 'nsr-menu-item-danger'),
                  ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
                  ...(item.textValue === undefined ? {} : { textValue: item.textValue }),
                  ...(item.onSelect === undefined ? {} : { onSelect: () => item.onSelect?.() }),
                },
                item.label,
              ),
        ),
      ),
    ),
  );
}
