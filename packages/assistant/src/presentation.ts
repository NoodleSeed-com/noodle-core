import type { AssistantPresentationTone, ResolvedAssistantAppearance } from './appearance.js';
import type { ResolvedAssistantThemeMode } from './element-theme-resolution.js';

export type AssistantSessionVisualState = 'idle' | 'loading' | 'ready' | 'error';

export function syncAssistantPresentation(
  host: HTMLElement,
  root: ShadowRoot,
  appearance: ResolvedAssistantAppearance,
  mode: ResolvedAssistantThemeMode,
  sessionState: AssistantSessionVisualState,
): void {
  const presentation = appearance.presentation;
  host.dataset.panelSurface = presentation.panel.surface;
  host.dataset.panelElevation = presentation.panel.elevation;
  host.dataset.panelBorder = presentation.panel.border;
  host.dataset.launcherStyle = presentation.launcher.style;
  host.dataset.launcherEffect = presentation.launcher.effect;
  host.dataset.messageUserStyle = presentation.messages.userStyle;
  host.dataset.messageAssistantStyle = presentation.messages.assistantStyle;
  host.dataset.sessionState = sessionState;

  const radius = presentation.panel.radius;
  if (radius === undefined) {
    host.style.removeProperty('--ns-assistant-presentation-panel-radius');
  } else {
    host.style.setProperty('--ns-assistant-presentation-panel-radius', `${radius}px`);
  }
  host.style.setProperty(
    '--ns-assistant-presentation-launcher-size',
    presentation.launcher.size === 'lg' ? '56px' : '44px',
  );
  host.style.setProperty(
    '--ns-assistant-presentation-panel-background',
    presentation.panel.surface === 'solid'
      ? 'var(--ns-assistant-panel, var(--ns-assistant-default-panel))'
      : 'color-mix(in srgb, var(--ns-assistant-panel, var(--ns-assistant-default-panel)) 50%, transparent)',
  );
  host.style.setProperty(
    '--ns-assistant-presentation-shadow',
    panelShadow(presentation.panel.elevation),
  );
  host.style.setProperty(
    '--ns-assistant-presentation-border',
    panelBorder(presentation.panel.border, mode),
  );

  replaceFallback(root, 'launcher-icon', [launcherVisual(appearance, mode, sessionState)]);
  const accessibleStatus = root.querySelector<HTMLElement>('[data-session-status]');
  if (accessibleStatus) {
    accessibleStatus.hidden = presentation.launcher.status !== 'session';
    accessibleStatus.textContent = sessionStateLabel(appearance, sessionState);
  }
  replaceFallback(root, 'header-leading', headerLeading(appearance, mode));
  replaceFallback(root, 'header-actions', headerBadge(appearance));
  replaceFallback(root, 'empty-state', [emptyState(appearance)]);
  replaceFallback(root, 'composer-leading', composerLeading(appearance, mode));
  replaceFallback(root, 'conversation-footer', []);

  const form = root.querySelector<HTMLFormElement>('.composer');
  if (form) form.dataset.shape = presentation.composer.shape;
  const send = root.querySelector<HTMLButtonElement>('.send');
  if (send) send.dataset.icon = presentation.composer.sendIcon;
}

export function syncAssistantSessionVisualState(
  host: HTMLElement,
  root: ShadowRoot | null,
  state: AssistantSessionVisualState,
  appearance: ResolvedAssistantAppearance,
): void {
  host.dataset.sessionState = state;
  root?.querySelectorAll<HTMLElement>('[data-session-indicator]').forEach((indicator) => {
    indicator.dataset.state = state;
  });
  root?.querySelectorAll<HTMLElement>('[data-session-status]').forEach((status) => {
    status.textContent = sessionStateLabel(appearance, state);
  });
}

function panelShadow(
  elevation: ResolvedAssistantAppearance['presentation']['panel']['elevation'],
): string {
  if (elevation === 'dramatic') {
    return '0 34px 100px color-mix(in srgb, var(--ns-assistant-overlay, var(--ns-assistant-default-overlay)) 72%, transparent)';
  }
  return 'var(--ns-assistant-default-shadow)';
}

function panelBorder(
  border: ResolvedAssistantAppearance['presentation']['panel']['border'],
  mode: ResolvedAssistantThemeMode,
): string {
  if (border === 'strong') {
    return '1px solid var(--ns-assistant-divider, var(--ns-assistant-default-divider))';
  }
  const opacity = mode === 'light' ? 60 : 100;
  return `1px solid color-mix(in srgb, var(--ns-assistant-divider, var(--ns-assistant-default-divider)) ${opacity}%, transparent)`;
}

function launcherVisual(
  appearance: ResolvedAssistantAppearance,
  mode: ResolvedAssistantThemeMode,
  sessionState: AssistantSessionVisualState,
): HTMLElement {
  const launcher = appearance.presentation.launcher;
  const visual = document.createElement('span');
  visual.className = 'launcher-visual';
  visual.setAttribute('aria-hidden', 'true');
  const visualKind =
    launcher.icon === 'brand-mark' && !(appearance.brand.mark[mode] ?? appearance.brand.logo[mode])
      ? launcher.style === 'bubble'
        ? 'chat'
        : 'none'
      : launcher.icon;
  visual.hidden = visualKind === 'none';
  visual.append(icon(visualKind, appearance, mode, 'launcher-glyph'));
  if (launcher.status === 'session') {
    const status = document.createElement('span');
    status.className = 'launcher-status';
    status.dataset.sessionIndicator = '';
    status.dataset.state = sessionState;
    visual.append(status);
  }
  return visual;
}

function sessionStateLabel(
  appearance: ResolvedAssistantAppearance,
  state: AssistantSessionVisualState,
): string {
  if (state === 'loading') return appearance.labels.sessionLoading;
  if (state === 'ready') return appearance.labels.sessionReady;
  if (state === 'error') return appearance.labels.sessionError;
  return appearance.labels.sessionIdle;
}

function headerLeading(
  appearance: ResolvedAssistantAppearance,
  mode: ResolvedAssistantThemeMode,
): HTMLElement[] {
  const variant = appearance.presentation.header.mark;
  if (variant === 'none') return [];
  const mark = document.createElement('span');
  mark.className = 'header-mark';
  mark.dataset.variant = variant;
  mark.setAttribute('aria-hidden', 'true');
  if (variant === 'brand-mark') {
    mark.append(icon('brand-mark', appearance, mode, 'header-mark-glyph'));
  } else {
    const core = document.createElement('span');
    core.className = 'header-mark-core';
    mark.append(core);
  }
  return [mark];
}

function headerBadge(appearance: ResolvedAssistantAppearance): HTMLElement[] {
  const config = appearance.presentation.header;
  if (!config.badge) return [];
  const group = document.createElement('div');
  group.className = 'header-actions';
  const badge = document.createElement('span');
  badge.className = 'header-badge';
  badge.dataset.tone = config.badge.tone;
  if (config.badge.indicator) badge.append(toneIndicator(config.badge.tone));
  const text = document.createElement('span');
  text.textContent = config.badge.text;
  badge.append(text);
  group.append(badge);
  return [group];
}

function emptyState(appearance: ResolvedAssistantAppearance): HTMLElement {
  const section = document.createElement('section');
  section.className = 'empty-state';
  section.hidden = !appearance.labels.welcomeHeading && !appearance.labels.welcomeMessage;

  if (appearance.labels.welcomeHeading) {
    const heading = document.createElement('h2');
    heading.textContent = appearance.labels.welcomeHeading;
    section.append(heading);
  }

  const description = appearance.labels.welcomeMessage;
  if (description) {
    const paragraph = document.createElement('p');
    paragraph.textContent = description;
    section.append(paragraph);
  }

  return section;
}

function composerLeading(
  appearance: ResolvedAssistantAppearance,
  mode: ResolvedAssistantThemeMode,
): HTMLElement[] {
  const leading = appearance.presentation.composer.leadingIcon;
  if (leading === 'none') return [];
  const wrapper = document.createElement('span');
  wrapper.className = 'composer-leading';
  wrapper.dataset.icon = leading;
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.append(icon(leading, appearance, mode, 'composer-leading-glyph'));
  return [wrapper];
}

function toneIndicator(tone: AssistantPresentationTone): HTMLElement {
  const indicator = document.createElement('i');
  indicator.className = 'tone-indicator';
  indicator.dataset.tone = tone;
  indicator.setAttribute('aria-hidden', 'true');
  return indicator;
}

function icon(
  kind: 'brand-mark' | 'chat' | 'none',
  appearance: ResolvedAssistantAppearance,
  mode: ResolvedAssistantThemeMode,
  className: string,
): HTMLElement {
  const mark = appearance.brand.mark[mode] ?? appearance.brand.logo[mode];
  if (kind === 'brand-mark' && mark) {
    const image = document.createElement('img');
    image.className = className;
    image.src = mark;
    image.alt = '';
    return image;
  }
  const glyph = document.createElement('span');
  glyph.className = className;
  glyph.dataset.icon = kind === 'brand-mark' ? 'sparkles' : kind;
  glyph.setAttribute('aria-hidden', 'true');
  return glyph;
}

function replaceFallback(root: ShadowRoot, slotName: string, nodes: readonly Node[]): void {
  const slot = root.querySelector<HTMLSlotElement>(`slot[name="${slotName}"]`);
  slot?.replaceChildren(...nodes);
}
