import { describe, expect, it, vi } from 'vitest';
import {
  ensurePersonalWorkspace,
  InMemoryControlPlaneStore,
  personalOrgSlug,
  ResendEmailSender,
  renderInvitationEmail,
  renderWelcomeEmail,
  resolveWelcomeEmailConfig,
  WelcomeEmailWorker,
} from '../src/index.js';

const IDENTITY = {
  subject: 'google-sub-123',
  email: 'developer@example.com',
  givenName: 'Alex',
  superAdmin: false,
};
const RESEND_OPTIONS = {
  apiKey: 'test-secret-key',
  welcomeFrom: 'Asad <asad@noodleseed.com>',
  invitationFrom: 'Noodle Seed <hello@noodleseed.com>',
} as const;

describe('first-signup welcome email outbox', () => {
  it('queues exactly one email when a personal workspace is first created', async () => {
    const store = new InMemoryControlPlaneStore();

    const [first, second] = await Promise.all([
      ensurePersonalWorkspace(store, IDENTITY),
      ensurePersonalWorkspace(store, IDENTITY),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await store.getWelcomeEmail(IDENTITY.subject)).toMatchObject({
      subject: IDENTITY.subject,
      email: IDENTITY.email,
      attemptCount: 0,
    });
  });

  it('rejects an unowned legacy workspace instead of claiming it during backfill', async () => {
    const store = new InMemoryControlPlaneStore();
    const slug = personalOrgSlug(IDENTITY);
    await store.createOrg({ slug, displayName: IDENTITY.email });

    await expect(ensurePersonalWorkspace(store, IDENTITY)).rejects.toThrow(/personal workspace/);

    expect(await store.getWelcomeEmail(IDENTITY.subject)).toBeUndefined();
    expect(await store.getOrgMember({ org: slug, subject: IDENTITY.subject })).toBeUndefined();
  });

  it('keeps a bound personal workspace stable across email changes', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = await ensurePersonalWorkspace(store, IDENTITY);

    const replay = await ensurePersonalWorkspace(store, {
      ...IDENTITY,
      email: 'renamed@example.com',
    });

    expect(replay).toEqual({ org: first.org, created: false });
    expect(await store.listOrgs()).toEqual([first.org]);
    expect(
      await store.getOrgMember({ org: first.org.slug, subject: IDENTITY.subject }),
    ).toMatchObject({ email: 'renamed@example.com', role: 'owner' });
  });

  it('fails closed when more than one legacy personal slug matches a principal', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = personalOrgSlug(IDENTITY);
    const second = personalOrgSlug({ ...IDENTITY, email: 'renamed@example.com' });
    for (const slug of [first, second]) {
      await store.createOrg({ slug });
      await store.addOrgMember({
        org: slug,
        subject: IDENTITY.subject,
        email: IDENTITY.email,
        role: 'owner',
      });
    }

    await expect(ensurePersonalWorkspace(store, IDENTITY)).rejects.toThrow(
      /legacy mapping is ambiguous/,
    );
    await expect(store.listOrgs()).resolves.toHaveLength(2);
  });

  it('binds a target-owned legacy personal workspace that also has another owner', async () => {
    const store = new InMemoryControlPlaneStore();
    const slug = personalOrgSlug(IDENTITY);
    await store.createOrg({ slug, displayName: IDENTITY.email });
    await store.addOrgMember({
      org: slug,
      subject: IDENTITY.subject,
      email: IDENTITY.email,
      role: 'owner',
    });
    await store.addOrgMember({
      org: slug,
      subject: 'co-owner',
      email: 'co-owner@example.com',
      role: 'owner',
    });

    await expect(ensurePersonalWorkspace(store, IDENTITY)).resolves.toMatchObject({
      org: { slug },
      created: false,
    });
    await expect(store.listOrgMembers(slug)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: IDENTITY.subject, role: 'owner' }),
        expect.objectContaining({ subject: 'co-owner', role: 'owner' }),
      ]),
    );
  });

  it('ignores an unrelated owner whose org merely collides with the legacy suffix', async () => {
    const store = new InMemoryControlPlaneStore();
    const suffix = personalOrgSlug(IDENTITY).slice(-9);
    const unrelated = `u-unrelated${suffix}`;
    await store.createOrg({ slug: unrelated });
    await store.addOrgMember({
      org: unrelated,
      subject: 'different-principal',
      email: 'other@example.com',
      role: 'owner',
    });

    const workspace = await ensurePersonalWorkspace(store, IDENTITY);

    expect(workspace).toMatchObject({ org: { slug: personalOrgSlug(IDENTITY) }, created: true });
    await expect(store.listOrgs()).resolves.toHaveLength(2);
  });

  it('leases a job so two workers cannot claim it concurrently', async () => {
    const now = new Date('2026-07-11T00:00:00.000Z');
    const store = new InMemoryControlPlaneStore({ now: () => now });
    await ensurePersonalWorkspace(store, IDENTITY);

    const first = await store.claimWelcomeEmail({ now, leaseMs: 30_000 });
    const second = await store.claimWelcomeEmail({ now, leaseMs: 30_000 });

    expect(first?.subject).toBe(IDENTITY.subject);
    expect(second).toBeUndefined();
  });
});

describe('welcome email content', () => {
  it('is a personal founder note with one primary documentation CTA', () => {
    const email = renderWelcomeEmail({ firstName: 'Alex' });

    expect(email.subject).toBe('Welcome to Noodle Seed');
    expect(email.text).toContain('Hi Alex,');
    expect(email.text).toContain("I'm Asad, founder of Noodle Seed");
    expect(email.text).toContain('https://docs.noodleseed.dev/docs/quickstart');
    expect(email.text).toContain('reply and tell me what you are building');
    expect(email.html).toContain('Open the developer docs');
    expect(email.html).toContain('https://noodleseed.dev/noodle-seed-logo-light.svg');
    expect(email.html).toContain('border-radius:999px');
    expect(email.text).toContain('Asad - Co-Founder & CTO');
    expect(email.text).not.toContain('—');
    expect(email.html).not.toContain('—');
    expect(email.html.match(/<a /g)).toHaveLength(1);
  });
});

describe('organisation invitation email content', () => {
  it('names the inviter and organisation with one accept CTA', () => {
    const email = renderInvitationEmail({
      inviterEmail: 'asad@noodleseed.com',
      orgName: 'Acme & Partners',
      role: 'developer',
      acceptUrl: 'https://console.noodleseed.dev/invitations/accept?org=acme#token=raw-token',
      expiresAt: '2026-07-18T00:00:00.000Z',
    });

    expect(email.subject).toBe('Asad invited you to Acme & Partners on Noodle Seed');
    expect(email.text).toContain('asad@noodleseed.com');
    expect(email.text).toContain('Accept invitation');
    expect(email.html).toContain('Accept invitation');
    expect(email.html).toContain('Acme &amp; Partners');
    expect(email.html).toContain('https://noodleseed.dev/noodle-seed-logo-light.svg');
    expect(email.html).toContain('border-radius:999px');
    expect(email.html.match(/<a /g)).toHaveLength(1);
  });
});

describe('Resend welcome email delivery', () => {
  it('disables delivery when unset and fails closed on partial configuration', () => {
    expect(resolveWelcomeEmailConfig({})).toBeUndefined();
    expect(() =>
      resolveWelcomeEmailConfig({ NOODLE_WELCOME_EMAIL_FROM: 'Asad <asad@example.com>' }),
    ).toThrow('RESEND_API_KEY is required when transactional email is configured');
    expect(resolveWelcomeEmailConfig({ RESEND_API_KEY: 'configured' })).toEqual({
      apiKey: 'configured',
      welcomeFrom: 'Asad <asad@noodleseed.com>',
      invitationFrom: 'Noodle Seed <hello@noodleseed.com>',
    });
  });

  it('sends the founder welcome from Asad with plain text, HTML, and an idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const sender = new ResendEmailSender({
      ...RESEND_OPTIONS,
      fetch: fetchMock,
    });

    await expect(
      sender.send({ subject: IDENTITY.subject, email: IDENTITY.email }),
    ).resolves.toEqual({ providerMessageId: 'email_123' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret-key');
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^welcome\.[a-f0-9]{64}$/);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Asad <asad@noodleseed.com>',
      to: [IDENTITY.email],
      subject: 'Welcome to Noodle Seed',
    });
    expect(body.reply_to).toBeUndefined();
    expect(body.text).toEqual(expect.any(String));
    expect(body.html).toEqual(expect.any(String));
    expect(String(init?.body)).not.toContain('test-secret-key');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a bounded provider error without exposing the API key or recipient', async () => {
    const sender = new ResendEmailSender({
      ...RESEND_OPTIONS,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: `bad test-secret-key for ${IDENTITY.email}` }), {
          status: 422,
        }),
      ),
    });

    await expect(sender.send({ subject: IDENTITY.subject, email: IDENTITY.email })).rejects.toThrow(
      'welcome email provider rejected request with status 422',
    );
  });

  it('sends an organisation invitation using its invitation hash for idempotency', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'email_invite' }));
    const sender = new ResendEmailSender({
      ...RESEND_OPTIONS,
      fetch: fetchMock,
    });

    await sender.sendInvitation({
      invitationId: 'hashed-invitation-token',
      email: 'teammate@example.com',
      inviterEmail: 'asad@noodleseed.com',
      orgName: 'Acme',
      role: 'developer',
      acceptUrl: 'https://console.noodleseed.dev/invitations/accept?org=acme#token=raw-token',
      expiresAt: '2026-07-18T00:00:00.000Z',
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^invitation\.[a-f0-9]{64}$/);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.from).toBe('Noodle Seed <hello@noodleseed.com>');
    expect(body.html).toContain('Accept invitation');
  });
});

describe('welcome email worker', () => {
  it('marks successful delivery and retries a failure with backoff', async () => {
    let now = new Date('2026-07-11T00:00:00.000Z');
    const store = new InMemoryControlPlaneStore({ now: () => now });
    await ensurePersonalWorkspace(store, IDENTITY);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ providerMessageId: 'email_456' });
    const worker = new WelcomeEmailWorker({
      store,
      sender: { send },
      clock: () => now,
    });

    await worker.runOnce();
    expect(await store.getWelcomeEmail(IDENTITY.subject)).toMatchObject({ attemptCount: 1 });

    now = new Date('2026-07-11T00:01:01.000Z');
    await worker.runOnce();
    expect(await store.getWelcomeEmail(IDENTITY.subject)).toMatchObject({
      attemptCount: 2,
      providerMessageId: 'email_456',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
