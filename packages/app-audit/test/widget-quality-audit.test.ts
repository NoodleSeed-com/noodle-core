import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { RECOMMENDED_COMPILED_WIDGET_HTML_BYTES } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { auditWidgetQualityFindings } from '../src/widget-quality-audit.js';

function artifactWithHtml(html: string): RuntimeArtifact {
  return {
    tools: [],
    resources: [
      {
        name: 'dashboard',
        uri: 'ui://quality/dashboard',
        mimeType: 'text/html;profile=mcp-app',
        fulfilment: {
          kind: 'flow',
          steps: [],
          output: { value: { kind: 'literal', value: html } },
        },
      },
    ],
  } as unknown as RuntimeArtifact;
}

describe('widget payload budget audit', () => {
  it('keeps the 1 MiB recommendation non-blocking and reports raw and gzip sizes', () => {
    const artifact = artifactWithHtml('a'.repeat(RECOMMENDED_COMPILED_WIDGET_HTML_BYTES + 1));
    const resources = artifact.resources ?? [];
    const finding = auditWidgetQualityFindings(artifact, resources, []).find(
      (item) => item.code === 'payload_budget',
    );

    expect(finding).toMatchObject({ severity: 'warn' });
    expect(finding?.message).toContain('1.0 MB raw');
    expect(finding?.message).toMatch(/gzip/);
    expect(finding?.message).toContain('recommended 1.0 MB');
    expect(finding?.message).toContain('hard limit 10.0 MB');
  });

  it('does not warn below the recommended bundle size', () => {
    const artifact = artifactWithHtml('a'.repeat(1024));
    const resources = artifact.resources ?? [];
    const finding = auditWidgetQualityFindings(artifact, resources, []).find(
      (item) => item.code === 'payload_budget',
    );

    expect(finding).toMatchObject({ severity: 'info' });
  });
});
