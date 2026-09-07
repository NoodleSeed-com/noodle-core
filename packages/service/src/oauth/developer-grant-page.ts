import type { DeveloperCapability } from '@noodle-borg/developer-mcp';

import { renderOAuthPage } from './branding.js';

export interface DeveloperGrantPageInput {
  readonly clientName: string;
  readonly resourceHost: string;
  readonly redirectHost: string;
  readonly userEmail: string;
  readonly grantToken: string;
  readonly grantAction: string;
  readonly capabilities: readonly DeveloperCapability[];
}

const CAPABILITY_COPY: Readonly<Record<DeveloperCapability, string>> = {
  'cloud:read': 'Read cloud apps, deployments, logs, analytics, and diagnostics',
  'deployments:write': 'Build and deploy apps',
  'deployments:rollback': 'Roll back deployments when you are an organization owner',
  'config:write': 'Set and remove variables and secrets (never read a secret back)',
};

export function renderDeveloperGrantPage(input: DeveloperGrantPageInput): string {
  const capabilities = input.capabilities
    .map((capability) => `<li>${escapeHtml(CAPABILITY_COPY[capability])}</li>`)
    .join('');
  const contentHtml = `<p class="ns-lede"><strong>${escapeHtml(input.clientName)}</strong> wants to use your Noodle Seed developer access.</p>
    <dl class="ns-dl">
      <div><dt class="ns-dt">Signed in as</dt><dd class="ns-dd">${escapeHtml(input.userEmail)}</dd></div>
      <div><dt class="ns-dt">Noodle Cloud</dt><dd class="ns-dd">${escapeHtml(input.resourceHost)}</dd></div>
      <div><dt class="ns-dt">Redirects to</dt><dd class="ns-dd">${escapeHtml(input.redirectHost)}</dd></div>
    </dl>
    <p class="ns-note">This connection can operate in the organizations and environments you can currently access. Your access updates automatically when your membership or role changes.</p>
    <ul>${capabilities}</ul>
    <p class="ns-note">Only authorize if you recognize this application.</p>
    <form method="post" action="${escapeHtml(input.grantAction)}">
      <input type="hidden" name="grant_token" value="${escapeHtml(input.grantToken)}" />
      <div class="ns-row">
        <button type="submit" name="decision" value="deny" class="btn btn-ghost">Deny</button>
        <span class="btn-glow"><button type="submit" name="decision" value="approve" class="btn btn-primary">Authorize</button></span>
      </div>
    </form>`;
  return renderOAuthPage({
    title: 'Authorize developer access — Noodle Seed',
    kicker: 'Developer access',
    heading: 'Authorize Noodle Seed developer access',
    contentHtml,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
