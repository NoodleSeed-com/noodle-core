import { describe, expect, it } from 'vitest';
import {
  contrastInk,
  contrastRatio,
  derivePalette,
  parseHex,
  relativeLuminance,
} from '../src/index.js';

/** Pull a single `--ns-foo:value` declaration's value out of a decl list. */
function tok(decls: readonly string[], name: string): string {
  const hit = decls.find((d) => d.startsWith(`${name}:`));
  if (hit === undefined) throw new Error(`missing token ${name} in ${decls.join(';')}`);
  return hit.slice(name.length + 1);
}

describe('widget-palette color math', () => {
  it('computes WCAG contrast on linearized sRGB (black/white ≈ 21:1)', () => {
    // The whole point of gamma-expanding channels: a naive average would not reach 21.
    expect(contrastRatio('#000000', '#ffffff')).toBeGreaterThan(20.9);
    expect(contrastRatio('#000000', '#ffffff')).toBeLessThan(21.1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('relative luminance is monotonic and normalized', () => {
    expect(relativeLuminance(parseHex('#000000'))).toBeCloseTo(0, 5);
    expect(relativeLuminance(parseHex('#ffffff'))).toBeCloseTo(1, 5);
    expect(relativeLuminance(parseHex('#1d9e75'))).toBeGreaterThan(
      relativeLuminance(parseHex('#0b1220')),
    );
  });

  it('picks readable ink: dark ink on a light accent, light ink on a dark accent', () => {
    const lightAccentInk = contrastInk('#F5C0A8'); // peach → dark ink
    const darkAccentInk = contrastInk('#1D3A8A'); // navy → light ink
    expect(relativeLuminance(parseHex(lightAccentInk))).toBeLessThan(0.3);
    expect(relativeLuminance(parseHex(darkAccentInk))).toBeGreaterThan(0.7);
    // The chosen ink must clear the 3:1 non-text-contrast floor against the button.
    expect(contrastRatio(lightAccentInk, '#F5C0A8')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(darkAccentInk, '#1D3A8A')).toBeGreaterThanOrEqual(3);
  });
});

describe('derivePalette', () => {
  it('derives a full, accessible, brand-tinted palette from accent alone', () => {
    const { light, dark, warnings } = derivePalette({ accent: '#1D9E75' });
    expect(warnings).toEqual([]);

    // Surface is near-white (not peach) and text clears WCAG AA against it.
    const surface = tok(light, '--ns-surface');
    const text = tok(light, '--ns-text-primary');
    expect(relativeLuminance(parseHex(surface))).toBeGreaterThan(0.8);
    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5);

    // Focus ring follows the brand instead of the hardcoded orange.
    expect(tok(light, '--ns-focus').toLowerCase()).toContain('1d9e75');

    // Accent shade variants are distinct, not three copies of the same hex.
    const accent = tok(light, '--ns-accent');
    const strong = tok(light, '--ns-accent-strong');
    const hot = tok(light, '--ns-accent-hot');
    expect(new Set([accent, strong, hot]).size).toBe(3);

    // Button ink is readable on the accent.
    expect(contrastRatio(tok(light, '--ns-accent-ink'), accent)).toBeGreaterThanOrEqual(3);

    // Dark scheme exists and is genuinely dark with readable light text.
    const darkSurface = tok(dark, '--ns-surface');
    expect(relativeLuminance(parseHex(darkSurface))).toBeLessThan(0.2);
    expect(contrastRatio(tok(dark, '--ns-text-primary'), darkSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('honors an explicit dark surface and derives light text + alpha borders from it', () => {
    const { dark } = derivePalette({ accent: '#1D9E75', surfaceDark: '#0B1220' });
    expect(tok(dark, '--ns-surface').toLowerCase()).toBe('#0b1220');
    expect(relativeLuminance(parseHex(tok(dark, '--ns-text-primary')))).toBeGreaterThan(0.7);
    // Borders are the text color at low alpha (rgba), keyed to the light text.
    expect(tok(dark, '--ns-border')).toMatch(/^rgba\(/);
  });

  it('falls back to an accent-tinted default for an omitted scheme, never an inversion', () => {
    // Light surface forced to white; the omitted dark scheme must NOT invert white into a
    // muddy near-black-of-white — it uses the engine default dark neutral, accent-tinted.
    const { dark } = derivePalette({ accent: '#1D9E75', surface: '#FFFFFF' });
    expect(relativeLuminance(parseHex(tok(dark, '--ns-surface')))).toBeLessThan(0.15);
  });

  it('warns when the accent has too little contrast against the background', () => {
    const { warnings } = derivePalette({ accent: '#FFFFFF', surface: '#FAFAFA' });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(' ')).toMatch(/accent/i);
  });

  it('emits nothing when no brand colors are supplied', () => {
    const { light, dark, warnings } = derivePalette({});
    expect(light).toEqual([]);
    expect(dark).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('is deterministic for the same input', () => {
    const a = derivePalette({ accent: '#1D9E75', surface: '#FFFFFF', surfaceDark: '#0B1220' });
    const b = derivePalette({ accent: '#1D9E75', surface: '#FFFFFF', surfaceDark: '#0B1220' });
    expect(a).toEqual(b);
  });
});
