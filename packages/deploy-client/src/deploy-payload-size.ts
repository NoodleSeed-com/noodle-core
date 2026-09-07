export const MAX_DEPLOY_BODY_BYTES = 32 * 1024 * 1024;

export function deployPayloadLimitMessage(body: string, manifest: string): string | undefined {
  const bytes = Buffer.byteLength(body);
  if (bytes <= MAX_DEPLOY_BODY_BYTES) return undefined;
  return `deploy request ${formatMiB(bytes)} exceeds the service limit ${formatMiB(MAX_DEPLOY_BODY_BYTES)}${largestWidgetContributors(manifest)}`;
}

function largestWidgetContributors(manifest: string): string {
  try {
    const parsed = JSON.parse(manifest) as {
      widgets?: readonly { name?: unknown; html?: unknown; view?: { compiledHtml?: unknown } }[];
    };
    const contributors = (parsed.widgets ?? [])
      .flatMap((widget) => {
        const html = widget.html ?? widget.view?.compiledHtml;
        return typeof widget.name === 'string' && typeof html === 'string'
          ? [{ name: widget.name, bytes: Buffer.byteLength(html) }]
          : [];
      })
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 3);
    return contributors.length === 0
      ? ''
      : `; largest widget bundles: ${contributors
          .map((item) => `${item.name} ${formatMiB(item.bytes)}`)
          .join(', ')}`;
  } catch {
    return '';
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
