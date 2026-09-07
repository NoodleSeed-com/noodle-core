/**
 * Branding palette derivation. Authors supply a few seed colors (accent + optional light/dark
 * background); the compiler derives a full, coherent, accessible set of widget CSS tokens from
 * them so every business theme — not just the warm Noodle default — renders correctly.
 *
 * Color mixing/shading is done in plain sRGB (good enough for token derivation; OKLCH/perceptual
 * mixing is intentionally out of scope). Contrast and luminance, however, use **linearized** sRGB
 * per WCAG 2.x — a naive average would mis-rank ink and produce illegible button text.
 *
 * Pure and dependency-free so it stays trivially unit-testable; it owns no I/O or CSS assembly.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Cool near-black / near-white inks used for text and button labels (kept neutral, never warm). */
const INK_DARK = '#101417';
const INK_LIGHT = '#f8fafc';

/** Engine default neutral backgrounds for a scheme whose surface the author left unset. */
const DEFAULT_LIGHT = '#ffffff';
const DEFAULT_DARK = '#141417';

/** Accent must clear this contrast against its background or buttons disappear into the surface. */
const ACCENT_SURFACE_MIN_CONTRAST = 2;

export function parseHex(hex: string): Rgb {
  const raw = hex.replace('#', '').trim();
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG relative luminance (0..1) over gamma-expanded sRGB channels. */
export function relativeLuminance(c: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio (1..21) between two colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB linear blend: `t` fraction of `b` mixed into `a`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

export const lighten = (hex: string, amount: number): string => mix(hex, '#ffffff', amount);
export const darken = (hex: string, amount: number): string => mix(hex, '#000000', amount);

/** The readable ink (near-black or near-white) for text/labels placed on `background`. */
export function contrastInk(background: string): string {
  return contrastRatio(INK_DARK, background) >= contrastRatio(INK_LIGHT, background)
    ? INK_DARK
    : INK_LIGHT;
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface BrandingPaletteInput {
  readonly accent?: string | undefined;
  readonly surface?: string | undefined;
  readonly surfaceDark?: string | undefined;
}

export interface DerivedPalette {
  /** CSS custom-property declarations for the light scheme (`:root`). */
  readonly light: readonly string[];
  /** CSS custom-property declarations for the dark scheme (`.dark`). */
  readonly dark: readonly string[];
  /** Non-fatal author diagnostics (e.g. an accent that vanishes into its background). */
  readonly warnings: readonly string[];
}

/** Derive surface/text/border tokens (and, when present, accent tokens) for a single scheme. */
function schemeTokens(surface: string, accent: string | undefined, isDark: boolean): string[] {
  const text = contrastInk(surface);
  const decls = [
    `--ns-background:${surface}`,
    `--ns-card:${surface}`,
    `--ns-card-foreground:${text}`,
    `--ns-popover:${surface}`,
    `--ns-popover-foreground:${text}`,
    `--ns-muted:${mix(surface, text, 0.05)}`,
    `--ns-muted-foreground:${mix(text, surface, 0.52)}`,
    `--ns-secondary:${mix(surface, text, 0.05)}`,
    `--ns-secondary-foreground:${text}`,
    `--ns-border:${rgba(text, 0.13)}`,
    `--ns-input:${rgba(text, 0.22)}`,
    `--ns-ring:${accent ?? text}`,
    `--ns-surface:${surface}`,
    `--ns-surface-raised:${mix(surface, text, 0.05)}`,
    `--ns-surface-soft:${rgba(text, 0.045)}`,
    `--ns-text-primary:${text}`,
    `--ns-text-secondary:${mix(text, surface, 0.32)}`,
    `--ns-text-muted:${mix(text, surface, 0.52)}`,
    `--ns-border-strong:${rgba(text, 0.22)}`,
  ];
  if (accent) {
    decls.push(
      // Accent is emitted verbatim to preserve the author's exact brand hex.
      `--ns-accent:${accent}`,
      `--ns-accent-foreground:${contrastInk(accent)}`,
      `--ns-primary:${accent}`,
      `--ns-primary-foreground:${contrastInk(accent)}`,
      `--ns-accent-strong:${isDark ? lighten(accent, 0.12) : darken(accent, 0.14)}`,
      `--ns-accent-hot:${isDark ? lighten(accent, 0.2) : lighten(accent, 0.1)}`,
      `--ns-accent-ink:${contrastInk(accent)}`,
      `--ns-focus:${accent}`,
    );
  }
  return decls;
}

export function derivePalette(input: BrandingPaletteInput): DerivedPalette {
  const accent = input.accent;
  const hasAccent = accent !== undefined;
  const anyBrand = hasAccent || input.surface !== undefined || input.surfaceDark !== undefined;
  if (!anyBrand) return { light: [], dark: [], warnings: [] };

  // Explicit backgrounds win; an omitted scheme uses the engine default neutral, accent-tinted —
  // never a luminance inversion of the other scheme (which yields muddy, off-brand grays).
  const lightSurface = toHex(
    parseHex(input.surface ?? (hasAccent ? mix(DEFAULT_LIGHT, accent, 0.05) : DEFAULT_LIGHT)),
  );
  const darkSurface = toHex(
    parseHex(input.surfaceDark ?? (hasAccent ? mix(DEFAULT_DARK, accent, 0.06) : DEFAULT_DARK)),
  );

  const warnings: string[] = [];
  if (hasAccent) {
    for (const [surface, label] of [
      [lightSurface, 'light'],
      [darkSurface, 'dark'],
    ] as const) {
      const ratio = contrastRatio(accent, surface);
      if (ratio < ACCENT_SURFACE_MIN_CONTRAST) {
        warnings.push(
          `branding.accent ${accent} has very low contrast (${ratio.toFixed(2)}:1) against the ${label} background ${surface}; primary buttons may be hard to see.`,
        );
      }
    }
  }

  return {
    light: schemeTokens(lightSurface, accent, false),
    dark: schemeTokens(darkSurface, accent, true),
    warnings,
  };
}
