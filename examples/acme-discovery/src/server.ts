import {
  annotations,
  authenticatedWebsite,
  connector,
  embeddedAssistant,
  file,
  knowledge,
  noodleManaged,
  publicWebsite,
  secret,
  server,
  site,
  tool,
  variable,
  z,
} from '@noodleseed/one';

// Acme Getaways is a fictional travel brand. This app is deliberately top-of-funnel: discovery and
// configuration happen inside ChatGPT; the booking/transaction happens off-app on Acme's own site,
// reached through a signed, attributable handoff deep link. Destinations are the partner's own
// catalog (grounding) — the app never invents a place, price, or best-month.
//
// Authoring note: a tool `fulfil` is *recorded*, not run as live JS. Inputs flow through as
// `${input.x}` substitutions when placed directly into an output string; do not transform them
// (no URL-encoding, arithmetic, or filtering on an input value — those break substitution). The
// curated catalog below is static data the runtime returns verbatim.

const catalog = [
  {
    id: 'coral_bay',
    name: 'Coral Bay',
    region: 'Adriatic coast',
    vibe: 'beach',
    priceFrom: 890,
    bestMonths: 'May–Sep',
    why: 'Calm swimming coves and a walkable old town — easy for a relaxed first trip.',
  },
  {
    id: 'monte_alto',
    name: 'Monte Alto',
    region: 'Northern Alps',
    vibe: 'mountains',
    priceFrom: 1120,
    bestMonths: 'Dec–Mar',
    why: 'Ski-in village with beginner slopes and long groomed runs.',
  },
  {
    id: 'old_quarter',
    name: 'Old Quarter',
    region: 'Central Europe',
    vibe: 'culture',
    priceFrom: 640,
    bestMonths: 'Apr–Oct',
    why: 'Dense museum district and food halls, all reachable on foot.',
  },
  {
    id: 'harbor_city',
    name: 'Harbor City',
    region: 'Pacific rim',
    vibe: 'city',
    priceFrom: 980,
    bestMonths: 'Sep–Nov',
    why: 'Waterfront nightlife and day-trip islands a short ferry away.',
  },
] as const;

// A closed set of URL-safe month values. A `fulfil` cannot url-encode an input (recording would break
// substitution), so the deep link carries `month` only if it is already safe — the model maps natural
// phrasing ("early June") onto one of these when it fills the tool.
const monthEnum = z
  .enum([
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ])
  .default('June');

// The catalog ids are already url-safe slugs. Constrain the handoff `destination` to this closed set so
// only a real, url-safe id can reach the deep link.
const destinationId = z.enum(['coral_bay', 'monte_alto', 'old_quarter', 'harbor_city']);

const discoverInput = z.object({
  vibe: z.enum(['beach', 'mountains', 'culture', 'city']).default('beach'),
  month: monthEnum,
  travelers: z.number().int().min(1).default(2),
});

// Tool annotations for host planners: reads are read-only, the handoff opens an external link, and
// shortlisting is a local non-destructive write.
const readOnly = annotations.readOnly();
const openLink = annotations.openAction();
const localWrite = annotations.localAction({ destructive: false, confirm: false });

const destinationOutput = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  vibe: z.string(),
  priceFrom: z.number(),
  bestMonths: z.string(),
  why: z.string(),
});

const discoverGetaways = tool('discover_getaways', {
  title: 'Discover getaways',
  description:
    'Suggest Acme Getaways destinations for a vibe and month and render a discovery carousel.',
  annotations: readOnly,
  input: discoverInput,
  output: z.object({
    status: z.string(),
    vibe: z.string(),
    month: z.string(),
    travelers: z.number(),
    // Bounded list: the curated catalog is fixed and small, and the declared ceiling tells the
    // model and host the payload cannot grow. `noodle check` reports `tool_design_output_bounds`.
    options: z.array(destinationOutput).max(20),
  }),
  // The carousel presents Acme's curated catalog; the model narrates which fit the stated vibe.
  // (A tool cannot filter on an input value — that is connector/flow work — so all are returned.)
  fulfil: ({ input }) => ({
    status: `Acme Getaways for a ${input.vibe} trip in ${input.month}, ${input.travelers} traveler(s).`,
    vibe: input.vibe,
    month: input.month,
    travelers: input.travelers,
    options: catalog,
  }),
  viewTitle: 'Discover getaways',
  // ChatGPT host status copy (openai/toolInvocation/*) — required for widget-opening tools.
  invoking: 'Finding getaways…',
  invoked: 'Getaways ready',
  domain: 'https://getaways.acme.example',
  view: {
    component: 'discovery-carousel',
    entry: './views/discovery-carousel.tsx',
  },
  viewDescription:
    'A top-of-funnel discovery carousel: pick a destination, then hand off to Acme to book.',
  csp: {
    connectDomains: ['https://acme.example'],
    resourceDomains: ['https://acme.example'],
    frameDomains: ['https://acme.example'],
  },
});

const createHandoff = tool('create_handoff', {
  title: 'Create booking handoff',
  description:
    'Create the Acme booking deep link for a chosen destination, carrying the configured trip. ' +
    'Pass the destination id (url-safe slug, e.g. "coral_bay") and its display name.',
  annotations: openLink,
  input: z.object({
    destination: destinationId,
    destinationName: z.string().min(1),
    month: monthEnum,
    travelers: z.number().int().min(1).default(2),
  }),
  output: z.object({
    status: z.string(),
    destination: z.string(),
    summary: z.string(),
    handoffUrl: z.string(),
  }),
  // Inline the inputs directly so they substitute at runtime; every value is already url-safe
  // (id slug, month enum, integer), and `src=chatgpt` is the attribution the partner measures
  // ChatGPT-sourced conversions on.
  fulfil: ({ input }) => ({
    status: `Ready to continue on Acme for ${input.destinationName}.`,
    destination: input.destination,
    summary: `${input.destinationName} · ${input.month} · ${input.travelers} traveler(s)`,
    handoffUrl: `https://book.acme.example/plan?dest=${input.destination}&month=${input.month}&pax=${input.travelers}&src=chatgpt`,
  }),
});

const shortlistGetaway = tool('shortlist_getaway', {
  visibility: ['app'],
  description: 'Record the traveler’s shortlisted destination from the discovery widget.',
  annotations: localWrite,
  input: z.object({
    destination: z.string(),
    note: z.string().default(''),
  }),
  output: z.object({
    status: z.string(),
    destination: z.string(),
    note: z.string(),
  }),
  fulfil: ({ input }) => ({
    status: `Shortlisted ${input.destination}.`,
    destination: input.destination,
    note: input.note,
  }),
});

// The consultative sales gateway (ADR 0214): when a visitor would rather not sign up, the assistant
// may — with explicit confirmation — take their details and deliver them to Acme's own sink. The
// recipe is a composition of existing primitives, not a platform feature: an ordinary confirm-gated
// action plus a declarative HTTP connector whose endpoint and credential are operator-managed
// (`noodle variables set LEAD_SINK_URL …`, `noodle secrets set LEAD_SINK_TOKEN …`). The payload
// rests only in Acme's own system; the platform stores no lead. A vendor sink is the same shape as
// data: Resend/Postmark take `auth: { kind: 'apiKey', … }`, a HubSpot private app takes
// `auth: { kind: 'bearer', … }` — never a named vendor package.
const leadSink = connector('lead_sink')
  .version('1.0.0')
  .http({
    baseUrl: variable('LEAD_SINK_URL'),
    allowedOrigins: ['https://acme.example'],
    auth: { kind: 'bearer', secret: secret('LEAD_SINK_TOKEN') },
    operations: {
      submit_lead: {
        type: 'action',
        method: 'POST',
        path: '/api/assistant-lead',
        input: z.object({
          name: z.string().trim().min(2).max(120),
          workEmail: z.email().max(240),
          company: z.string().trim().min(2).max(200),
          note: z.string().max(500),
        }),
        output: z.object({ ok: z.boolean() }),
        request: {
          name: '${args.name}',
          workEmail: '${args.workEmail}',
          company: '${args.company}',
          note: '${args.note}',
          // Fixed attribution, set here rather than model-supplied: Acme's sink can trust it.
          source: 'website-assistant',
        },
        response: { ok: '${response.ok}' },
      },
    },
  });

const captureLead = tool('capture_lead', {
  title: 'Send my details to Acme',
  description:
    'Send the visitor’s contact details and trip interest to Acme Getaways so the team may follow ' +
    'up. Call only after the visitor explicitly agrees to be contacted; the confirmation card is ' +
    'their consent moment. After a confirmed success, say only that the details were sent — never ' +
    'promise response timing.',
  annotations: annotations.action({ confirm: true }),
  input: z.object({
    name: z.string().trim().min(2).max(120).meta({ title: 'Your name' }),
    workEmail: z.email().max(240).meta({ title: 'Work email' }),
    company: z.string().trim().min(2).max(200).meta({ title: 'Company' }),
    note: z.string().max(500).default('').meta({ title: 'What are you planning?' }),
  }),
  output: z.object({ ok: z.boolean() }),
  fulfil: ({ input, connectors }) => {
    const result = connectors.leads.submitLead({
      name: input.name,
      workEmail: input.workEmail,
      company: input.company,
      note: input.note,
    });
    return { ok: result.ok };
  },
});

// The mixed surface's sign-in trigger (ADR 0201): reading `${user.id}` classifies this tool
// requires-identity, so an anonymous visitor who reaches for it sees the sign-in card instead of an
// error — and after signing in on Acme's account origin, the conversation continues under the
// authenticated surface below.
const myTrips = tool('my_trips', {
  title: 'My saved trips',
  description: 'Read the signed-in traveler’s saved trips and their booking status.',
  annotations: readOnly,
  input: z.object({}),
  output: z.object({
    traveler: z.string(),
    status: z.string(),
  }),
  fulfil: ({ user }) => ({
    traveler: user.id as string,
    status: 'No trips booked yet — shortlist a getaway to start one.',
  }),
});

// Grounding beyond the catalog: two controlled files answer policy/pricing/support questions with
// citations, and Acme's live public site is crawled on deploy and re-crawled on the declared
// refresh cadence — no sync job, no handwritten search tool. One declaration, one generated
// `search_destinations` capability. The managed crawler and index are the defaults; a component
// can instead bring its own via `crawler: firecrawl({ apiKey: secret('FIRECRAWL_API_KEY') })`
// and `index: algolia({ appId: variable('ALGOLIA_APP_ID'), apiKey: secret('ALGOLIA_API_KEY') })`
// — the code names the config, `noodle secrets|variables set` supplies the values.
const destinations = knowledge('destinations', {
  title: 'Acme Getaways destinations',
  description: 'Public destination, pricing, cancellation, and support information.',
  documents: [
    file('./knowledge/product.md', {
      title: 'Product guide',
      sourceUrl: 'https://getaways.acme.example/product',
    }),
    file('./knowledge/faq.txt', { title: 'FAQ' }),
  ],
  sites: [
    site({
      origin: 'https://getaways.acme.example',
      include: ['/destinations/**', '/pricing', '/support'],
      refresh: '12h',
    }),
  ],
});

export default server(
  'acme_discovery',
  {
    title: 'Acme Getaways',
    version: '1.0.0',
    branding: {
      name: 'Acme Getaways',
      accent: '#0EA5A4',
      surface: '#F0FDFA',
      surfaceDark: '#0B1B1B',
      radius: 'lg',
      density: 'comfortable',
    },
    // The only external destinations the app links out to — the compiler derives ChatGPT's
    // redirect_domains from this so the handoff opens without a safe-link warning.
    handoff: {
      allowedDomains: ['https://book.acme.example', 'https://acme.example'],
    },
    use: { leads: leadSink },
    // The same tools also serve Acme's own websites, with no second tool set. The marketing site is
    // a **mixed** surface (`signIn: true`): a visitor with no account gets discovery, the booking
    // handoff, and the confirm-gated lead capture — and reaching for `my_trips` raises the sign-in
    // card instead of an error, with `signUpAction` offering account creation through Acme's own
    // registration. After the login redirect lands on the account origin, the same conversation
    // continues under the authenticated surface's capabilities and instructions (ADR 0201).
    // `capabilities` is the whole externally reachable surface per front door — short enough to
    // review in one glance, and closed by default when a tool is added to the server later.
    assistant: embeddedAssistant({
      model: noodleManaged(),
      access: [
        publicWebsite({
          origins: ['https://getaways.acme.example'],
          // A browser agent on Acme's marketing page (Gemini-in-Chrome, Claude-in-Chrome) discovers
          // exactly the capabilities listed below and reaches them over the same authorization,
          // confirmation, budget, and audit path the panel's own calls take: `capture_lead` still
          // stops for its confirmation card. `site/index.html` is the page this runs on.
          webmcp: { enabled: true },
          // A visitor who asks about Coral Bay on one page and clicks through to another would
          // otherwise arrive at an empty panel and have to start over. This carries the text they
          // have already read onto the next page, on a fresh session — never the old session's
          // authority, budget, or a half-answered confirmation (ADR 0223). Opt-in because anonymous
          // conversation text is Acme's content on Acme's page; the defaults below are deliberately
          // tighter than the platform ceiling.
          continuity: { enabled: true, windowSeconds: 300, maxRestores: 3 },
          capabilities: [
            destinations,
            discoverGetaways,
            createHandoff,
            shortlistGetaway,
            captureLead,
            myTrips,
          ],
          signIn: true,
          instructions:
            'Be a friendly, consultative travel guide, never pushy. Help visitors narrow a getaway before suggesting the next useful step. Ground recommendations in Acme knowledge, and clearly separate discovery from booking. When a visitor’s plans firm up, invite them to sign in or create an account; if they would rather not, offer — once — to send their details to the Acme team instead.',
        }),
        authenticatedWebsite({
          origins: ['https://account.acme.example'],
          capabilities: [destinations, discoverGetaways, createHandoff, myTrips],
          instructions:
            'The traveler is signed in. Help them plan from their saved trips, and keep booking on Acme’s own pages through the handoff.',
        }),
      ],
      layout: { mode: 'floating', position: 'bottom-right' },
      labels: {
        welcomeHeading: 'Where would you like to go?',
        signInHeading: 'Continue with your Acme account',
        signInBody: 'Saved trips need an account.',
        signInAction: 'Sign in',
        signUpAction: 'Create free account',
      },
    }),
    knowledge: [destinations],
  },
  [discoverGetaways, createHandoff, shortlistGetaway, captureLead, myTrips],
);
