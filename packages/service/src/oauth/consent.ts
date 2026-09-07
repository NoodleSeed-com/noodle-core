/**
 * The consent interstitial (OA-2, [ADR 0042]). **Required**, not optional: because the authorization server
 * federates every dynamically-registered client through one upstream-human application, the MCP 2025-11-25 spec
 * mandates explicit per-client user consent before issuing a code (confused-deputy mitigation). The page
 * shows the requesting client and where the code will be sent, so the owner can refuse an unfamiliar app.
 */
import { renderOAuthPage } from './branding.js';

export interface ConsentPageInput {
  readonly clientName: string;
  readonly resourceHost: string;
  readonly redirectHost: string;
  readonly userEmail: string;
  /** Signed, short-lived token carrying the full authorization context (tamper-proof). */
  readonly consentToken: string;
  /** Where the Approve/Deny form POSTs (the AS consent endpoint). */
  readonly consentAction: string;
  readonly allowAccountSwitch?: boolean;
  /** Server-owned registration purpose, never inferred from the client display name. */
  readonly portal?: boolean;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderConsentPage(input: ConsentPageInput): string {
  const client = esc(input.clientName);
  const resource = esc(input.resourceHost);
  const redirect = esc(input.redirectHost);
  const email = esc(input.userEmail);
  const token = esc(input.consentToken);
  const action = esc(input.consentAction);
  const contentHtml = `<p class="ns-lede"><strong>${client}</strong> wants to access your Noodle Seed ${input.portal ? 'business workspace' : 'MCP server'}.</p>
    <dl class="ns-dl">
      <div><dt class="ns-dt">Signed in as</dt><dd class="ns-dd">${email}</dd></div>
      <div><dt class="ns-dt">${input.portal ? 'Business workspace' : 'MCP server'}</dt><dd class="ns-dd">${resource}</dd></div>
      <div><dt class="ns-dt">Redirects to</dt><dd class="ns-dd">${redirect}</dd></div>
    </dl>
    <p class="ns-note">Only approve if you recognize this application.</p>
    <form method="post" action="${action}">
      <input type="hidden" name="consent_token" value="${token}" />
      ${
        input.allowAccountSwitch === true
          ? '<button type="submit" name="decision" value="switch_account" class="btn btn-ghost">Use another account</button>'
          : ''
      }
      <div class="ns-row">
        <button type="submit" name="decision" value="deny" class="btn btn-ghost">Deny</button>
        <span class="btn-glow"><button type="submit" name="decision" value="approve" class="btn btn-primary">Approve</button></span>
      </div>
    </form>`;
  return renderOAuthPage({
    title: 'Authorize access — Noodle Seed',
    kicker: 'Authorize',
    heading: input.portal
      ? 'Authorize access to your workspace'
      : 'Authorize access to your server',
    contentHtml,
  });
}
