export function normalizePersistedManifestForCompile(manifest: string): string {
  const trimmed = manifest.trimStart();
  if (!trimmed.startsWith('{')) return manifest;

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return manifest;
  }

  let changed = false;
  const markChanged = (): void => {
    changed = true;
  };
  normalizeLegacyManifestVersion(parsed, markChanged);
  normalizeManifestWidgetScreens(parsed, markChanged);
  return changed ? JSON.stringify(parsed) : manifest;
}

/**
 * Records persisted before the Core v1 bump carry `manifestVersion: "0.2"` (ADR 0150). The `"0.2"`
 * shape is a strict subset of `"1"` (the settle pass only dropped/reserved fields the SDK never
 * emitted), so upgrading the version label is the whole migration. Retire this once hosted records
 * have been redeployed under `"1"` (see DRIFT-WATCH).
 */
function normalizeLegacyManifestVersion(manifest: unknown, markChanged: () => void): void {
  if (!isRecord(manifest) || manifest.manifestVersion !== '0.2') return;
  manifest.manifestVersion = '1';
  markChanged();
}

function normalizeManifestWidgetScreens(manifest: unknown, markChanged: () => void): void {
  if (!isRecord(manifest) || !Array.isArray(manifest.widgets)) return;
  for (const widget of manifest.widgets) {
    if (!isRecord(widget) || !isRecord(widget.screen)) continue;
    normalizeUiNode(widget.screen.root, markChanged);
  }
}

function normalizeUiNode(node: unknown, markChanged: () => void): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeUiNode(item, markChanged);
    return;
  }
  if (!isRecord(node)) return;

  const type = typeof node.type === 'string' ? node.type : undefined;
  if (type === 'card') normalizeLegacyCard(node, markChanged);
  if (type === 'form') normalizeLegacyForm(node, markChanged);
  if (type === 'button') normalizeLegacyButton(node, markChanged);

  for (const value of Object.values(node)) normalizeUiNode(value, markChanged);
}

function normalizeLegacyCard(node: Record<string, unknown>, markChanged: () => void): void {
  if ('body' in node && !('children' in node)) {
    node.children = node.body;
    markChanged();
  }
  if ('body' in node) {
    delete node.body;
    markChanged();
  }
}

function normalizeLegacyForm(node: Record<string, unknown>, markChanged: () => void): void {
  if ('state' in node && !('name' in node)) {
    node.name = node.state;
    markChanged();
  }
  if ('state' in node) {
    delete node.state;
    markChanged();
  }
}

function normalizeLegacyButton(node: Record<string, unknown>, markChanged: () => void): void {
  if ('intent' in node && !('variant' in node)) {
    node.variant = node.intent === 'primary' ? 'default' : node.intent;
    markChanged();
  }
  if ('intent' in node) {
    delete node.intent;
    markChanged();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
