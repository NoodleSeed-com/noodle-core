import { Children, createElement, isValidElement, type ReactNode, useState } from 'react';

/**
 * Display atoms for the Noodle widget kit. Hand-rolled on native elements (no external library), styled
 * through the host-adaptive token contract so they re-skin per host. `Avatar` shows an image or an initials
 * fallback; `AvatarGroup` overlaps a set of avatars with an optional `+N` overflow bubble.
 */

function join(...parts: readonly (string | undefined | false)[]): string | undefined {
  const value = parts.filter(Boolean).join(' ');
  return value.length === 0 ? undefined : value;
}

/** First letters of the first two words, uppercased — e.g. "Ada Lovelace" → "AL". */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export type AvatarProps = {
  readonly src?: string;
  readonly alt?: string;
  /** Used to derive the initials fallback when no `src` is given. */
  readonly name?: string;
  /** Pixel diameter; defaults to 32. */
  readonly size?: number;
  readonly className?: string;
};

export function Avatar({ src, alt, name, size = 32, className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const style = { width: size, height: size };
  if (src !== undefined && failedSrc !== src) {
    return createElement('img', {
      src,
      alt: alt ?? name ?? '',
      className: join('nsr-avatar', className),
      style,
      onError: () => setFailedSrc(src),
    });
  }
  const label = name ? initials(name) : '';
  return createElement(
    'span',
    {
      className: join('nsr-avatar', 'nsr-avatar-fallback', className),
      style,
      role: 'img',
      'aria-label': alt ?? name ?? undefined,
    },
    label,
  );
}

export type AvatarGroupProps = {
  /** `Avatar` elements to overlap. */
  readonly children: ReactNode;
  /** Show at most this many, then a `+N` overflow bubble. */
  readonly max?: number;
  readonly className?: string;
};

export function AvatarGroup({ children, max, className }: AvatarGroupProps) {
  const items = Children.toArray(children);
  const shown = max === undefined ? items : items.slice(0, max);
  const overflow = items.length - shown.length;
  const first = shown[0];
  const overflowSize = isValidElement<AvatarProps>(first) ? (first.props.size ?? 32) : 32;
  return createElement(
    'div',
    { className: join('nsr-avatar-group', className) },
    ...shown,
    overflow > 0
      ? createElement(
          'span',
          {
            key: 'overflow',
            className: 'nsr-avatar nsr-avatar-fallback nsr-avatar-more',
            'aria-label': `${overflow} more`,
            style: { width: overflowSize, height: overflowSize },
          },
          `+${overflow}`,
        )
      : null,
  );
}
