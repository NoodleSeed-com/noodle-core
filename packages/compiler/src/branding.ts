import { contrastRatio, derivePalette } from '@noodle-borg/brand-kit';
import type { RuntimeArtifact } from './artifact/types.js';
import type { CompileWarning } from './errors.js';
import type { Manifest } from './manifest/schema.js';

export function brandingWarnings(
  branding: Manifest['server']['branding'],
): readonly CompileWarning[] {
  if (branding === undefined) return [];
  const warnings: CompileWarning[] = derivePalette({
    accent: branding.accent,
    surface: branding.surface,
    surfaceDark: branding.surfaceDark,
  }).warnings.map((message) => ({
    code: 'branding_low_contrast',
    path: 'server.branding.accent',
    message,
  }));
  for (const mode of ['light', 'dark'] as const) {
    const theme = branding.theme?.[mode];
    const surface = theme?.surface ?? (mode === 'light' ? branding.surface : branding.surfaceDark);
    for (const [foreground, background, label, minimum] of [
      [theme?.text, surface, 'text/surface', 4.5],
      [theme?.accentText, theme?.accent ?? branding.accent, 'accentText/accent', 3],
      [theme?.link, surface, 'link/surface', 4.5],
    ] as const) {
      if (!foreground || !background) continue;
      const ratio = contrastRatio(foreground, background);
      if (ratio < minimum) {
        warnings.push({
          code: 'branding_low_contrast',
          path: `server.branding.theme.${mode}`,
          message: `${mode} ${label} contrast is ${ratio.toFixed(2)}:1; expected at least ${minimum}:1.`,
        });
      }
    }
  }
  return warnings;
}

export function normalizeRuntimeBranding(
  branding: Manifest['server']['branding'],
): RuntimeArtifact['server']['branding'] {
  if (!branding) return undefined;
  const palette = derivePalette({
    accent: branding.accent,
    surface: branding.surface,
    surfaceDark: branding.surfaceDark,
  });
  const light = { ...portableTheme(palette.light), ...branding.theme?.light };
  const dark = { ...portableTheme(palette.dark), ...branding.theme?.dark };
  return {
    ...branding,
    ...(Object.keys(light).length > 0 || Object.keys(dark).length > 0
      ? {
          theme: {
            ...(Object.keys(light).length > 0 ? { light } : {}),
            ...(Object.keys(dark).length > 0 ? { dark } : {}),
          },
        }
      : {}),
  } as RuntimeArtifact['server']['branding'];
}

function portableTheme(declarations: readonly string[]): Record<string, string> {
  const values = new Map(
    declarations.map((declaration) => {
      const index = declaration.indexOf(':');
      return [declaration.slice(0, index), declaration.slice(index + 1)] as const;
    }),
  );
  const mappings = {
    surface: '--ns-surface',
    surfaceRaised: '--ns-surface-raised',
    surfaceMuted: '--ns-muted',
    text: '--ns-text-primary',
    textMuted: '--ns-text-muted',
    accent: '--ns-accent',
    accentText: '--ns-accent-ink',
    border: '--ns-border',
    borderStrong: '--ns-border-strong',
    focus: '--ns-focus',
  } as const;
  return Object.fromEntries(
    Object.entries(mappings).flatMap(([key, variable]) => {
      const value = values.get(variable);
      return value ? [[key, value]] : [];
    }),
  );
}
