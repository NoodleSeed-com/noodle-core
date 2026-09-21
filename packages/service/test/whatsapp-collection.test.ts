import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applyConfirmation,
  ChannelCoordinator,
  type ChannelStore,
  InMemoryChannelStore,
  loadCollection,
  saveCollection,
} from '@noodle-borg/assistant-gateway/portable';
import { PostgresChannelStore } from '@noodle-borg/assistant-gateway/postgres';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { ChannelSecretBoxCipher } from '../src/channels/cipher.js';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';

const PRIVATE_EMAIL = 'maya@example.com';
const WORKFLOW = 'Answer product questions from our website and WhatsApp.';
const CONSENT_QUESTION =
  'Do you agree to Noodle Seed contacting you about this request? Yes or no.';
const manifest = `manifestVersion: "2"
server:
  name: channel_collect
  version: 1.0.0
  title: Noodle Seed
  branding: { name: Noodle Seed }
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: [https://noodleseed.dev]
    surfaces:
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{kind: tool, name: open_contact_form}, {kind: tool, name: submit_enquiry}] }
  collections:
    - name: leads
      title: Leads
      description: Prospective customers who asked Noodle Seed for help.
      schemaVersion: 1
      publicFields: [contact_name, contact_email, company, website, workflow_summary, consent_to_contact]
      recordSchema:
        type: object
        additionalProperties: false
        required: [contact_name, contact_email, company, workflow_summary, consent_to_contact]
        properties:
          contact_name: { type: string, maxLength: 120 }
          contact_email: { type: string, maxLength: 254 }
          company: { type: string, maxLength: 200 }
          website: { type: string, maxLength: 2048 }
          workflow_summary: { type: string, maxLength: 2000 }
          consent_to_contact: { type: boolean }
connectors:
  records: { id: noodle_records, version: 1.0.0 }
tools:
  - name: open_contact_form
    description: Open an enquiry when the visitor explicitly asks to talk to Noodle Seed.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema:
      type: object
      properties: { workflow: { type: string, minLength: 10, maxLength: 240 } }
      required: [workflow]
      additionalProperties: false
    outputSchema:
      type: object
      properties: { workflow: { type: string }, policy: { type: string } }
      required: [workflow]
      additionalProperties: false
    fulfilment: { steps: [], output: { workflow: '\${input.workflow}', policy: 'The form below is ready.' } }
    interaction:
      kind: collect
      action: submit_enquiry
      initialValues: { workflow: { fromOutput: workflow } }
      fields:
        - { key: fullName, control: text }
        - { key: workEmail, control: email, private: true }
        - { key: company, control: text }
        - { key: website, control: url, optional: true }
        - { key: workflow, control: textarea }
        - { key: consentToContact, control: consent }
      review: all
      outcome: { success: Your enquiry was saved. }
  - name: submit_enquiry
    description: Save the reviewed enquiry as one lead.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, confirm: true }
    visibility: [app]
    inputSchema:
      type: object
      additionalProperties: false
      required: [workflow, fullName, workEmail, company, website, consentToContact]
      properties:
        workflow: { type: string, minLength: 10, maxLength: 240, title: Workflow }
        fullName: { type: string, minLength: 2, maxLength: 120, title: Your name }
        workEmail: { type: string, maxLength: 254, title: Work email }
        company: { type: string, minLength: 2, maxLength: 200, title: Company }
        website: { type: string, maxLength: 2048, pattern: '^(?:|https?://[^\\s]+)$', title: Company website }
        consentToContact: { type: boolean, const: true, title: Permission to contact you }
    fulfilment:
      steps:
        - id: saved
          use: records.submit_record
          args:
            collection: leads
            payload:
              contact_name: '\${input.fullName}'
              contact_email: '\${input.workEmail}'
              company: '\${input.company}'
              website: '\${input.website}'
              workflow_summary: '\${input.workflow}'
              consent_to_contact: '\${input.consentToContact}'
      output: { ok: '\${steps.saved.ok}' }
`;

const databaseUrl = process.env.DATABASE_URL_TEST;
const tenant = { org: 'acme', app: 'site', env: 'prod' };
const path = '/v1/orgs/acme/apps/site/envs/prod/channels/whatsapp';
const MAYA = '15551234567';
const OTHER = '15557654321';

interface ModelRequest {
  readonly messages: { role: string; content?: string }[];
  readonly response_format?: unknown;
  readonly tools?: { function: { name: string } }[];
}

for (const durable of [false, true]) {
  describe.skipIf(durable && !databaseUrl)(
    `WhatsApp natural collection saves one lead (${durable ? 'postgres' : 'memory'})`,
    () => {
      const schema = `wa_collect_${randomUUID().replaceAll('-', '')}`;
      const admin = durable ? new Pool({ connectionString: databaseUrl, max: 1 }) : undefined;
      const pool = durable
        ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
        : undefined;
      const worker = new ChannelWorkerLoop();
      const registry = new ServerRegistry();
      const business = new InMemoryBusinessInformationStore();
      interface SentMessage {
        readonly to: string;
        readonly type: string;
        readonly text?: { body: string };
        readonly interactive?: {
          body: { text: string };
          action: { buttons: { type: string; reply: { id: string; title: string } }[] };
        };
      }
      const sent: SentMessage[] = [];
      const body = (message: SentMessage | undefined) =>
        message?.text?.body ?? message?.interactive?.body.text ?? '';
      const offeredIds = (message: SentMessage | undefined) =>
        message?.interactive?.action.buttons.map((button) => button.reply.id) ?? [];
      const modelRequests: ModelRequest[] = [];
      const logs: string[] = [];
      let clock = Date.now();
      let store: ChannelStore;
      let http: Server;
      let base: string;
      let bindingId: string;
      let mayaId: string;
      const providerSecret = 'a'.repeat(32);
      const callbackSecret = 'b'.repeat(32);

      const call = (suffix: string, method = 'GET', body?: unknown) =>
        fetch(`${base}${path}${suffix}`, {
          method,
          headers: {
            authorization: 'Bearer owner',
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const webhook = (from: string, text: string) =>
        fetch(`${base}/v1/channels/whatsapp/webhooks/${bindingId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-noodle-webhook-secret': callbackSecret,
          },
          body: JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                changes: [
                  {
                    field: 'messages',
                    value: {
                      messaging_product: 'whatsapp',
                      metadata: { phone_number_id: 'owned' },
                      messages: [
                        {
                          id: `incoming-${randomUUID()}`,
                          from,
                          timestamp: String(Math.floor(clock / 1000)),
                          type: 'text',
                          text: { body: text },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        });
      /** Deliver a tapped reply button exactly as the provider webhook reports it. */
      const tap = (from: string, id: string, title = 'Confirm') =>
        fetch(`${base}/v1/channels/whatsapp/webhooks/${bindingId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-noodle-webhook-secret': callbackSecret,
          },
          body: JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                changes: [
                  {
                    field: 'messages',
                    value: {
                      messaging_product: 'whatsapp',
                      metadata: { phone_number_id: 'owned' },
                      messages: [
                        {
                          id: `tap-${randomUUID()}`,
                          from,
                          timestamp: String(Math.floor(clock / 1000)),
                          type: 'interactive',
                          context: { from: 'owned', id: 'wamid.review' },
                          interactive: { type: 'button_reply', button_reply: { id, title } },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        });
      const unboundTaps = async () =>
        ((await (await call('/events')).json()) as { data: { code?: string }[] }).data.filter(
          (event) => event.code === 'button_unbound',
        ).length;
      /** A tap that binds to nothing is closed silently: no send, one content-free event code. */
      async function ignoredTap(from: string, id: string): Promise<void> {
        clock += 15_000;
        const before = sent.length;
        const ignored = await unboundTaps();
        expect((await tap(from, id)).status).toBe(200);
        await vi.waitFor(async () => expect(await unboundTaps()).toBe(ignored + 1), {
          timeout: 15_000,
        });
        expect(sent).toHaveLength(before);
      }
      /** Tap a review button and return the reply the provider was asked to deliver. */
      async function tapReply(from: string, id: string): Promise<string> {
        clock += 15_000;
        const before = sent.length;
        expect((await tap(from, id)).status).toBe(200);
        await vi.waitFor(() => expect(sent.length).toBe(before + 1), { timeout: 15_000 });
        return body(sent[before]);
      }
      /** Send one message and return the reply the provider was asked to deliver. */
      async function converse(from: string, text: string): Promise<string> {
        // Real conversations pace themselves; the fixed clock must not trip the per-minute limit.
        clock += 15_000;
        const before = sent.length;
        expect((await webhook(from, text)).status).toBe(200);
        await vi.waitFor(() => expect(sent.length).toBe(before + 1), { timeout: 15_000 });
        return body(sent[before]);
      }
      const ledgerOf = (participantId: string) =>
        store.transaction([bindingId], (tx) => loadCollection(tx, bindingId, participantId));
      const records = async () =>
        (await business.listRequests({ scope: installationScope(), collectionKey: 'leads' }))
          .records;
      const installationScope = () => ({ ...tenant, installationId: 'site-prod' });
      const lastUser = (request: ModelRequest) =>
        [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

      function fakeModel(body: ModelRequest) {
        const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
        const answer = (content: string) =>
          Response.json({ choices: [{ message: { role: 'assistant', content } }], usage });
        if (body.response_format !== undefined) {
          const system = body.messages[0]?.content ?? '';
          const user = body.messages[1]?.content ?? '';
          if (system.includes('Fields:')) {
            if (user.includes('Maple Labs Inc'))
              return answer(JSON.stringify({ company: 'Maple Labs Inc' }));
            if (user.includes('Maya'))
              return answer(JSON.stringify({ fullName: 'Maya Chen', company: 'Maple Labs' }));
            return answer('{}');
          }
          return answer(JSON.stringify({ affirmative: /\bsure\b/i.test(user), confidence: 0.97 }));
        }
        const last = body.messages.at(-1);
        if (last?.role === 'tool')
          return answer('Happy to help. What is your name, company and work email?');
        if (
          body.tools?.some((tool) => tool.function.name === 'open_contact_form') &&
          /talk to someone/i.test(lastUser(body))
        )
          return Response.json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call-open',
                      type: 'function',
                      function: {
                        name: 'open_contact_form',
                        arguments: JSON.stringify({ workflow: WORKFLOW }),
                      },
                    },
                  ],
                },
              },
            ],
            usage,
          });
        return answer('Noodle Seed answers product questions on your website and WhatsApp.');
      }

      beforeAll(async () => {
        if (durable && admin && pool) {
          await admin.query(`CREATE SCHEMA ${schema}`);
          const postgres = new PostgresChannelStore(
            pool,
            new ChannelSecretBoxCipher(new SecretBox(staticMasterKeyProvider(randomBytes(32)))),
          );
          await postgres.ensureSchema();
          store = postgres;
        } else store = new InMemoryChannelStore();
        for (const [name, value] of [
          ['WHATSAPP_API_KEY', providerSecret],
          ['WHATSAPP_WEBHOOK_SECRET', callbackSecret],
        ] as const)
          await registry.configStore.setConfigValue({
            kind: 'secret',
            scope: { level: 'env', ...tenant },
            name,
            value,
          });
        const controlPlane = new InMemoryControlPlaneStore();
        await controlPlane.createOrgWithOwner({
          slug: 'acme',
          owner: { subject: 'owner', email: 'owner@example.test' },
        });
        http = createServer(
          createServiceHandler(registry, {
            controlPlaneStore: controlPlane,
            businessInformationStore: business,
            businessInformationEnabled: true,
            publicBaseUrl: 'https://service.example',
            clock: () => new Date(clock),
            logger: {
              debug: () => undefined,
              info: () => undefined,
              warn: (message, fields) => logs.push(JSON.stringify([message, fields])),
              error: (message, fields) => logs.push(JSON.stringify([message, fields])),
            },
            deployGate: {
              authorize: async () => ({
                ok: true,
                identity: { subject: 'owner', email: '', superAdmin: false },
              }),
            },
            whatsapp: {
              store,
              worker,
              providerFetch: async (url, init) => {
                const endpoint = new URL(String(url));
                if (endpoint.pathname === '/health_status')
                  return Response.json({
                    id: 'owned',
                    health_status: { can_send_message: 'AVAILABLE' },
                  });
                if (endpoint.pathname === '/v1/configs/webhook') return Response.json({ url: '' });
                if (endpoint.pathname === '/messages') {
                  sent.push(JSON.parse(String(init?.body)));
                  return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
                }
                throw new Error('unexpected provider operation');
              },
            },
            managedAssistantModelResolver: {
              resolve: async () => ({
                source: 'noodle-managed',
                baseUrl: 'https://model.example/v1',
                model: 'test-pinned',
                apiKey: 'model-secret',
                requestPolicy: { maxModelStepsPerTurn: 3, maxCompletionTokens: 1000 },
                inferenceCost: {
                  version: 'test-bounds',
                  validUntil: '2099-01-01T00:00:00Z',
                  maxInputTokens: 10000,
                  maxBilledOutputTokens: 2000,
                  inputMicroUsdPerMillionTokens: 300000,
                  outputMicroUsdPerMillionTokens: 2500000,
                },
              }),
            },
            assistantModelFetch: async (_url, init) => {
              const body = JSON.parse(String(init?.body)) as ModelRequest;
              modelRequests.push(body);
              return fakeModel(body);
            },
          }),
        );
        const deployed = await registry.deploy(tenant, manifest, { accessMode: 'public' });
        if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
        const target = await registry.getActiveByTenant(tenant);
        if (!target) throw new Error('deployment unavailable');
        const selector = {
          publisherOrg: tenant.org,
          app: tenant.app,
          environment: tenant.env,
          deploymentId: deployed.deploymentId,
        };
        await business.createInstallation({
          scope: installationScope(),
          definition: privateDefinitionFromDeployment(selector, {
            ...tenant,
            environment: tenant.env,
            deploymentId: deployed.deploymentId,
            artifact: target.served.artifact,
          }),
          managedCollections: ['leads'],
          actorSubject: 'owner',
          actorEmail: 'owner@example.test',
        });
        worker.start();
        await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        const configured = await call('', 'PUT', {
          expectedRevision: 0,
          phoneNumberId: 'owned',
          apiKeySecret: 'WHATSAPP_API_KEY',
          webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
          capabilities: [
            { kind: 'tool', name: 'open_contact_form' },
            { kind: 'tool', name: 'submit_enquiry' },
          ],
          supportEmail: 'hello@noodleseed.com',
        });
        expect(configured.status, await configured.clone().text()).toBe(200);
        const { data: binding } = (await configured.json()) as {
          data: { id: string; revision: number };
        };
        bindingId = binding.id;
        // Readiness needs a durable store and a live provider; the journey under test starts once
        // an operator has enabled the binding, so enable it through the coordinator directly.
        const channels = new ChannelCoordinator(store, () => clock);
        await channels.markReady(bindingId, binding.revision);
        await channels.setState(bindingId, 'enabled', 'operator', 'enable', binding.revision);
      });
      afterAll(async () => {
        await worker.stop();
        if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
        if (pool) await pool.end();
        if (admin) {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        }
      });

      it('reports request capture as native only with durable custody and the installed collection', async () => {
        const doctor = (await (await call('/readiness', 'POST', {})).json()) as {
          data: { capabilities: { capability: string; status: string; code?: string }[] };
        };
        expect(doctor.data.capabilities).toContainEqual(
          durable
            ? { capability: 'capture_request', status: 'native' }
            : expect.objectContaining({
                capability: 'capture_request',
                status: 'needs_setup',
                code: 'durable_storage_required',
              }),
        );
        expect(doctor.data.capabilities.map((entry) => entry.capability)).not.toContain(
          'answer_questions',
        );
      });

      it('ignores a tapped button that binds to no review without any model call', async () => {
        modelRequests.length = 0;
        await ignoredTap(MAYA, 'b_forged');
        expect(modelRequests).toHaveLength(0);
        expect(logs.join('\n')).not.toContain('b_forged');
      });

      it('opens, collects, asks consent, reviews verbatim, confirms once and replays safely', async () => {
        const opened = await converse(MAYA, 'I would like to talk to someone at Noodle Seed.');
        expect(opened).toContain('AI assistant');
        expect(opened).toContain('What is your name, company and work email?');
        const toolResult = modelRequests
          .flatMap((request) => request.messages)
          .find((message) => message.role === 'tool')?.content;
        expect(toolResult).toContain('"collection":"opened"');
        expect(toolResult).not.toContain('form below');
        const events = (await (await call('/events')).json()) as {
          data: { participantId: string }[];
        };
        mayaId = events.data[0]?.participantId ?? '';
        expect(await ledgerOf(mayaId)).toMatchObject({
          phase: 'collecting',
          values: { workflow: WORKFLOW },
        });

        modelRequests.length = 0;
        const consent = await converse(MAYA, `I'm Maya Chen at Maple Labs, ${PRIVATE_EMAIL}`);
        expect(consent).toBe(CONSENT_QUESTION);
        expect(modelRequests).toHaveLength(1);
        expect(JSON.stringify(modelRequests)).not.toContain(PRIVATE_EMAIL);
        expect(JSON.stringify(modelRequests)).toContain('[email captured]');

        modelRequests.length = 0;
        const review = await converse(MAYA, 'sure');
        expect(modelRequests).toHaveLength(1);
        expect(JSON.stringify(modelRequests)).not.toContain('Maple Labs');
        expect(review).toBe(
          [
            'Your name: Maya Chen',
            `Work email: ${PRIVATE_EMAIL}`,
            'Company: Maple Labs',
            'Company website: none',
            `Workflow: ${WORKFLOW}`,
            'Contact permission: yes',
            '',
            'Shall I send it?',
          ].join('\n'),
        );

        modelRequests.length = 0;
        const edited = await converse(MAYA, 'yes but change the company to Maple Labs Inc');
        expect(modelRequests).toHaveLength(1);
        expect(edited).toContain('Company: Maple Labs Inc');
        expect(edited).toContain('Shall I send it?');
        const proposed = await ledgerOf(mayaId);
        expect(proposed?.phase).toBe('awaiting_confirmation');
        expect(proposed?.proposal).toBeDefined();

        modelRequests.length = 0;
        expect(await converse(MAYA, 'okay')).toBe('Your enquiry was saved.');
        expect(modelRequests).toHaveLength(0);
        const saved = await records();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
          origin: { kind: 'messaging', reference: 'whatsapp' },
          content: {
            payload: {
              contact_name: 'Maya Chen',
              contact_email: PRIVATE_EMAIL,
              company: 'Maple Labs Inc',
              website: '',
              workflow_summary: WORKFLOW,
              consent_to_contact: true,
            },
          },
        });

        expect(await converse(MAYA, 'okay')).toBe('Your enquiry was saved.');
        expect(modelRequests).toHaveLength(0);
        expect(await records()).toHaveLength(1);

        // A worker lost between the record commit and the receipt re-enters the executing phase
        // with the same proposal, even after the proposal clock has lapsed: the connector replays its
        // receipt and no second lead exists.
        if (proposed === undefined) throw new Error('proposal');
        await store.transaction([bindingId], (tx) =>
          saveCollection(tx, applyConfirmation(proposed, 'confirm', clock)),
        );
        clock += 11 * 60_000;
        expect(await converse(MAYA, 'hello?')).toBe('Your enquiry was saved.');
        expect(await records()).toHaveLength(1);
      });

      it('creates nothing on cancel, expiry, another participant, or a blocked confirmation', async () => {
        const reopened = await converse(MAYA, 'Could I talk to someone again about a second site?');
        expect(reopened).toContain('What is your name');
        expect(await converse(MAYA, `Maya Chen, Maple Labs, ${PRIVATE_EMAIL}`)).toBe(
          CONSENT_QUESTION,
        );
        expect(await converse(MAYA, 'yes')).toContain('Shall I send it?');
        expect(await converse(MAYA, 'cancel')).toBe(
          'Okay, I have cancelled that. Nothing was sent.',
        );
        expect(await ledgerOf(mayaId)).toBeUndefined();
        expect(await records()).toHaveLength(1);

        expect(await converse(MAYA, 'Let me talk to someone once more.')).toContain(
          'What is your name',
        );
        expect(await converse(MAYA, `Maya Chen at Maple Labs, ${PRIVATE_EMAIL}`)).toBe(
          CONSENT_QUESTION,
        );
        expect(await converse(MAYA, 'yes')).toContain('Shall I send it?');
        expect(await converse(OTHER, 'okay')).toContain('Noodle Seed answers product questions');
        expect(await records()).toHaveLength(1);

        const pending = (await ledgerOf(mayaId))?.proposal;
        if (pending === undefined) throw new Error('proposal');
        const blocked = await call('/blocks', 'POST', { participantId: mayaId, until: null });
        expect(blocked.status, await blocked.clone().text()).toBe(200);
        const before = sent.length;
        expect((await webhook(MAYA, 'okay')).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(sent).toHaveLength(before);
        expect(await records()).toHaveLength(1);
        expect((await call(`/blocks/${mayaId}`, 'DELETE', {})).status).toBe(200);
        expect((await ledgerOf(mayaId))?.proposal?.id).toBe(pending.id);

        clock += 11 * 60_000;
        expect(await converse(MAYA, 'okay')).toContain('That review expired');
        expect(await ledgerOf(mayaId)).toBeUndefined();
        expect(await records()).toHaveLength(1);
      });

      it('offers the review as Confirm, Edit and Cancel buttons bound to that proposal alone', async () => {
        expect(await converse(MAYA, 'I want to talk to someone about a third site.')).toContain(
          'What is your name',
        );
        expect(await converse(MAYA, `Maya Chen, Maple Labs, ${PRIVATE_EMAIL}`)).toBe(
          CONSENT_QUESTION,
        );
        expect(await converse(MAYA, 'yes')).toContain('Shall I send it?');
        const offered = sent.at(-1);
        expect(offered?.type).toBe('interactive');
        const buttons = offered?.interactive?.action.buttons ?? [];
        expect(buttons.map((button) => button.reply.title)).toEqual(['Confirm', 'Edit', 'Cancel']);
        for (const button of buttons) {
          expect(button.type).toBe('reply');
          expect(button.reply.id).toMatch(/^b_[A-Za-z0-9_-]{43}$/);
          expect(button.reply.id).not.toMatch(/maya|maple|example|enquiry|leads/i);
        }
        const [confirm, edit] = offeredIds(offered);
        if (confirm === undefined || edit === undefined) throw new Error('buttons');

        // Edit withdraws the proposal: its buttons die and the next message is the change.
        modelRequests.length = 0;
        expect(await tapReply(MAYA, edit)).toBe('Sure. What would you like to change?');
        expect(modelRequests).toHaveLength(0);
        await ignoredTap(MAYA, confirm);
        const edited = await converse(MAYA, 'change the company to Maple Labs Inc');
        expect(edited).toContain('Company: Maple Labs Inc');
        expect(edited).toContain('Shall I send it?');
        const again = offeredIds(sent.at(-1));
        expect(again).toHaveLength(3);
        expect(again).not.toContain(confirm);
        const reconfirm = again[0];
        if (reconfirm === undefined) throw new Error('buttons');
        await ignoredTap(OTHER, reconfirm);
        expect(await records()).toHaveLength(1);

        modelRequests.length = 0;
        expect(await tapReply(MAYA, reconfirm)).toBe('Your enquiry was saved.');
        expect(modelRequests).toHaveLength(0);
        expect(sent.at(-1)?.type).toBe('text');
        const saved = await records();
        expect(saved).toHaveLength(2);
        expect(saved.map((record) => record.content.payload.company)).toContain('Maple Labs Inc');
        expect(await tapReply(MAYA, reconfirm)).toBe('Your enquiry was saved.');
        expect(await records()).toHaveLength(2);

        expect(await converse(MAYA, 'Could I talk to someone about a fourth site?')).toContain(
          'What is your name',
        );
        expect(await converse(MAYA, `Maya Chen, Maple Labs, ${PRIVATE_EMAIL}`)).toBe(
          CONSENT_QUESTION,
        );
        expect(await converse(MAYA, 'yes')).toContain('Shall I send it?');
        const cancel = offeredIds(sent.at(-1))[2];
        if (cancel === undefined) throw new Error('buttons');
        expect(await tapReply(MAYA, cancel)).toBe('Okay, I have cancelled that. Nothing was sent.');
        expect(await ledgerOf(mayaId)).toBeUndefined();
        expect(await records()).toHaveLength(2);
      });

      it('keeps the private email out of every model request, the transcript, the journal and logs', async () => {
        expect(modelRequests.length).toBeGreaterThan(0);
        expect(JSON.stringify(modelRequests)).not.toContain(PRIVATE_EMAIL);
        expect(JSON.stringify(modelRequests)).toContain('[Work email withheld]');
        expect(logs.join('\n')).not.toContain(PRIVATE_EMAIL);
        const rows = await store.transaction([bindingId], async (tx) => [
          await tx.get(bindingId, mayaId),
          ...(await tx.list(bindingId, { kind: 'event', limit: 1000 })),
        ]);
        expect(rows.length).toBeGreaterThan(2);
        expect(JSON.stringify(rows)).not.toContain(PRIVATE_EMAIL);
        expect(JSON.stringify(rows)).toContain('[Work email withheld]');
        if (pool) {
          const sealed = await pool.query('SELECT sealed::text FROM assistant_channel_records');
          expect(JSON.stringify(sealed.rows)).not.toContain(PRIVATE_EMAIL);
        }
      });
    },
  );
}
