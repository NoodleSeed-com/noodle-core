import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { DeveloperGrantAuthorizer } from '../src/oauth/developer-grant-authorizer.js';
import { renderDeveloperGrantPage } from '../src/oauth/developer-grant-page.js';

const CLI_RESOURCE = 'https://cloud.noodleseed.com/developer/cli';
const MCP_RESOURCE = 'https://cloud.noodleseed.com/developer/mcp';

describe('developer grant consent page', () => {
  it('renders one compact authorization decision without organization or environment controls', () => {
    const html = renderDeveloperGrantPage({
      clientName: 'Claude <Code>',
      userEmail: 'owner@example.com',
      resourceHost: 'cloud.noodleseed.com',
      redirectHost: 'claude.ai',
      grantToken: 'signed-token',
      grantAction: '/oauth/developer-grant',
      capabilities: ['cloud:read', 'deployments:rollback'],
    });
    const document = parse(html);

    expect(html).toContain('Claude &lt;Code&gt;');
    expect(html).toContain('owner@example.com');
    expect(html).toContain('cloud.noodleseed.com');
    expect(html).toContain('claude.ai');
    expect(html).toContain('organizations and environments you can currently access');
    expect(html).toContain(
      'Your access updates automatically when your membership or role changes',
    );
    expect(html).toContain('Read cloud apps, deployments, logs, analytics, and diagnostics');
    expect(html).toContain('Roll back deployments when you are an organization owner');
    expect(document.querySelector('input[name="grant_token"]')?.getAttribute('value')).toBe(
      'signed-token',
    );
    expect(document.querySelector('button[value="approve"]')?.textContent).toContain('Authorize');
    expect(document.querySelector('button[value="deny"]')).not.toBeNull();
    expect(document.querySelector('input[name="org"]')).toBeNull();
    expect(document.querySelector('input[name="environment"]')).toBeNull();
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(html).not.toContain('data-developer-grant');
    expect(html).not.toContain('data-org-panel');
  });

  it('describes CLI capabilities without exposing secret plaintext access', () => {
    const html = renderDeveloperGrantPage({
      clientName: 'Noodle CLI',
      userEmail: 'user@example.com',
      resourceHost: 'cloud.noodleseed.com',
      redirectHost: 'localhost',
      grantToken: 'signed-token',
      grantAction: '/oauth/developer-grant',
      capabilities: ['cloud:read', 'deployments:write', 'config:write'],
    });

    expect(html).toContain('Build and deploy apps');
    expect(html).toContain('Set and remove variables and secrets');
    expect(html).toContain('never read a secret back');
    expect(html).not.toContain('Choose organization');
    expect(html).not.toContain('Choose environments');
  });
});

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document;
}

describe('DeveloperGrantAuthorizer', () => {
  it('creates one reusable live-user grant with capabilities derived from the protected resource', async () => {
    let nextId = 0;
    const grants = new InMemoryDeveloperGrantStore({ id: () => `grant-${++nextId}` });
    const authorizer = new DeveloperGrantAuthorizer({ grants });

    const first = await authorizer.authorize({
      clientId: 'client-1',
      subject: 'owner-sub',
      resource: CLI_RESOURCE,
    });
    const repeated = await authorizer.authorize({
      clientId: 'client-1',
      subject: 'owner-sub',
      resource: CLI_RESOURCE,
    });

    expect(first).toMatchObject({
      version: 2,
      id: 'grant-1',
      resource: CLI_RESOURCE,
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'config:write', 'deployments:write'],
    });
    expect(repeated.id).toBe(first.id);
    await expect(
      authorizer.findActive({
        clientId: 'client-1',
        subject: 'owner-sub',
        resource: CLI_RESOURCE,
      }),
    ).resolves.toMatchObject({ id: first.id });
  });

  it('keeps the MCP and CLI grants separate and rejects non-developer resources', async () => {
    let nextId = 0;
    const authorizer = new DeveloperGrantAuthorizer({
      grants: new InMemoryDeveloperGrantStore({ id: () => `grant-${++nextId}` }),
    });

    const mcp = await authorizer.authorize({
      clientId: 'client-1',
      subject: 'owner-sub',
      resource: MCP_RESOURCE,
    });
    const cli = await authorizer.authorize({
      clientId: 'client-1',
      subject: 'owner-sub',
      resource: CLI_RESOURCE,
    });

    expect(mcp.id).not.toBe(cli.id);
    expect(mcp.capabilities).toEqual(['cloud:read', 'deployments:rollback']);
    expect(cli.capabilities).toEqual(['cloud:read', 'config:write', 'deployments:write']);
    await expect(
      authorizer.authorize({
        clientId: 'client-1',
        subject: 'owner-sub',
        resource: 'https://cloud.noodleseed.com/',
      }),
    ).rejects.toThrow('invalid developer resource');
  });
});
