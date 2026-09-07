import { Window } from 'happy-dom';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_WIDGET_URI,
  AnalyticsWidget,
  APP_OVERVIEW_WIDGET_URI,
  AppOverviewWidget,
  DEPLOYMENT_DETAIL_WIDGET_URI,
  DEVELOPER_WIDGETS,
  DeploymentDetailWidget,
  OPERATIONS_WIDGET_URI,
  OperationsWidget,
  renderDeveloperWidget,
} from '../src/widgets/resources.js';

const expectedWidgets = [
  [APP_OVERVIEW_WIDGET_URI, AppOverviewWidget],
  [DEPLOYMENT_DETAIL_WIDGET_URI, DeploymentDetailWidget],
  [OPERATIONS_WIDGET_URI, OperationsWidget],
  [ANALYTICS_WIDGET_URI, AnalyticsWidget],
] as const;

describe('Noodle Developer MCP widgets', () => {
  it('publishes the four fixed, versioned MCP App resources with closed CSP', () => {
    expect(DEVELOPER_WIDGETS.map((widget) => widget.uri)).toEqual([
      'ui://noodle-developer/app-overview/v1',
      'ui://noodle-developer/deployment-detail/v1',
      'ui://noodle-developer/operations/v1',
      'ui://noodle-developer/analytics/v1',
    ]);
    for (const widget of DEVELOPER_WIDGETS) {
      expect(widget.mimeType).toBe('text/html;profile=mcp-app');
      expect(widget._meta).toMatchObject({
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          prefersBorder: true,
        },
      });
    }
  });

  it.each(
    expectedWidgets,
  )('%s renders one accessible, script-free React document body', (uri, View) => {
    const raw = renderToStaticMarkup(createElement(View as ComponentType));
    const document = parse(`<html><body>${raw}</body></html>`);

    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(headingLevels(document)).toSatisfy(orderedHeadings);
    expect(
      document.querySelector('[aria-live="polite"][data-noodle-action-status]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-status-label]')?.textContent).toContain('Status:');
    expect(raw).not.toMatch(/<script|\son[a-z]+=/i);
    expect(raw).not.toMatch(/authorization|bearer|password|secretValue|api[_-]?key/i);

    for (const button of document.querySelectorAll('button')) {
      expect(button.getAttribute('type')).toBe('button');
      expect((button.getAttribute('aria-label') ?? button.textContent).trim()).not.toBe('');
    }

    const resource = renderDeveloperWidget(uri);
    expect(resource).toBeDefined();
    if (resource === undefined) return;
    const served = parse(resource.text);
    expect(served.documentElement.getAttribute('lang')).toBe('en');
    expect(served.querySelector('style')?.textContent).toContain(
      '@layer reset, tokens, base, components, utilities',
    );
    expect(served.querySelector('style')?.textContent).toMatch(/var\(--color-[^)]+,/);
    expect(served.querySelectorAll('script')).toHaveLength(1);
    expect(served.querySelector('script')?.textContent).toContain('globalThis.ExtApps');
    expect(served.querySelector('[src^="http"], [href^="http"]')).toBeNull();
  });

  it('binds app overview only to public app inspection fields', () => {
    const document = componentDocument(AppOverviewWidget);
    expect(bindings(document)).toEqual(
      expect.arrayContaining([
        'data.app',
        'data.selectedEnvironment',
        'data.active',
        'data.latest.deploymentId',
        'data.latest.createdAt',
        'data.latest.ownerSubject',
      ]),
    );
    expect(document.querySelector('[data-collection="data.environments"]')).not.toBeNull();
  });

  it('binds deployment detail and declares a server-tool rollback action for an explicit candidate', () => {
    const document = componentDocument(DeploymentDetailWidget);
    expect(bindings(document)).toEqual(
      expect.arrayContaining([
        'data.target.app',
        'data.target.env',
        'data.deployment.deploymentId',
        'data.deployment.endpointUrl',
        'data.deployment.ownerSubject',
        'data.rollback.ownerSubject',
        'data.health.state',
      ]),
    );
    const rollback = document.querySelector(
      'button[data-action="call"][data-action-tool="rollback_deployment"]',
    );
    expect(rollback?.hasAttribute('hidden')).toBe(true);
    expect(rollback?.getAttribute('data-bind-if')).toBe('data.rollbackCandidate.deploymentId');
    expect(rollback?.getAttribute('data-action-args')).toBe(
      '{"app":"{{data.target.app}}","env":"{{data.target.env}}","deploymentId":"{{data.rollbackCandidate.deploymentId}}"}',
    );
  });

  it('renders bounded operations collections with explicit empty states', () => {
    const document = componentDocument(OperationsWidget);
    expect(document.querySelector('[data-collection="data.findings"]')).not.toBeNull();
    expect(document.querySelector('[data-collection="data.events"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-collection-empty]')).toHaveLength(2);
  });

  it('renders analytics metrics and makes partial data visible', () => {
    const document = componentDocument(AnalyticsWidget);
    expect(bindings(document)).toEqual(
      expect.arrayContaining([
        'data.metrics.totals.requests',
        'data.metrics.totals.toolCalls',
        'data.metrics.errors.errorRate',
        'data.metrics.latency.p95Ms',
        'data.truncated',
        'data.window.since',
      ]),
    );
    expect(document.querySelector('[data-bind-if="data.truncated"]')?.textContent).toMatch(
      /partial/i,
    );
    expect(
      document.querySelector('[data-collection="data.metrics.clientActivity.callers"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-collection="data.metrics.clientActivity.legacyHandshakes.byReportedClient"]',
      ),
    ).not.toBeNull();
    const templateMarkup = [...document.querySelectorAll('template')]
      .map((template) => template.innerHTML)
      .join('');
    expect(templateMarkup).toContain('data-bind="caller.reportedName"');
    expect(templateMarkup).toContain('data-bind="handshake.reportedName"');
    expect(document.body.textContent).toMatch(/separate telemetry unit/i);
    expect(document.body.textContent).not.toMatch(/Sessions/);
  });

  it('returns undefined for an unregistered widget URI', () => {
    expect(renderDeveloperWidget('ui://noodle-developer/unknown/v1')).toBeUndefined();
  });
});

function componentDocument(View: ComponentType): Document {
  return parse(`<html><body>${renderToStaticMarkup(createElement(View))}</body></html>`);
}

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document;
}

function bindings(document: Document): string[] {
  return [...document.querySelectorAll('[data-bind]')]
    .map((element) => element.getAttribute('data-bind'))
    .filter((value): value is string => value !== null);
}

function headingLevels(document: Document): number[] {
  return [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading) =>
    Number(heading.tagName.slice(1)),
  );
}

function orderedHeadings(levels: number[]): boolean {
  return levels.every((level, index) => index === 0 || level <= (levels[index - 1] ?? 1) + 1);
}
