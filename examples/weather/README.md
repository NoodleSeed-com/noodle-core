# Weather Briefing

Two declarative tools that show the runtime's breadth working together, with **no auth and no API
keys**. The `weather_briefing` tool takes a city name and runs a **three-step flow**:

Capability slots: HTTP connector authoring, ordered fulfilment flows, query/response mapping,
**list-returning connector output** (a connector that returns a live, variable-length array), and
sandboxed compute, including an explicit least-privilege per-operation response-size bound.

For a different API with an OpenAPI document, start with `noodle import openapi <file>` in a separate
directory. It preserves supported typed JSON bodies and scalar parameters; unsupported input encodings
stop import instead of dropping fields. Its offline test establishes the contract, not live behavior; follow the
[connector guide](https://docs.noodleseed.dev/docs/guides/connectors) before replacing this curated flow.

1. **`geo.search`** → geocode the city to coordinates (Open-Meteo Geocoding API)
2. **`forecast.current`** → fetch current weather for those coordinates (Open-Meteo Forecast API)
3. **`brief.summarize`** → derive a human-readable briefing in a **WASM/QuickJS compute sandbox**

The second tool, `search_places`, shows a connector returning a **live, variable-length list**: it binds
the whole Open-Meteo geocoding `results` array with `${response.results}`, then narrows each match to
`{ id, label }` in a compute connector — the "search → a list of options the model can pick from"
pattern. Narrowing lives in compute because a `${...}` response mapping cannot iterate an array and a
tool's Zod output does not strip fields at runtime.

It exercises, in one TypeScript-authored app:

- **Server-level branding** with semantic tokens carried through the runtime artifact for any generated
  app surface.
- **Ordered flow execution** with outputs threaded between steps (`${steps.geo.latitude}` → next step).
- **Two HTTP connectors on two different hosts**, each with its own egress allowlist.
- **Query parameters** (`query: [...]`) and a constant query baked into the path (`?current_weather=true`).
- **Deep response mapping** with the `${...}` language — single-element indexing
  (`${response.results[0].latitude}`, `${response.current_weather.temperature}`) **and** whole-array
  binding (`${response.results}` returns the entire list verbatim).
- **A list-returning connector + compute narrowing** — `geo.search_list` binds the whole `results`
  array; `places.narrow` reduces each element to `{ id, label }` and normalizes the no-results case
  to `[]`.
- **A per-operation transport bound** — `search_list` sets
  `limits: { maxResponseBytes: 256 * 1024 }`, tightening this known-small endpoint below the 1 MiB default.
  The authoring ceiling is 6 MiB, but grant only the bytes representative evidence proves this operation
  needs.
- **Sandboxed compute** (no network/fs/env/clock) turning raw numbers into conditions + advice.
- **Typed input/output schemas** emitted as JSON Schema 2020-12.

## APIs that require form-urlencoded search bodies

The live Open-Meteo calls above are GET requests. For APIs whose search endpoint is a POST expecting
`application/x-www-form-urlencoded`, keep authoring a request object and select the encoding explicitly:

```ts
search_quotes: {
  type: 'read',
  method: 'POST',
  path: '/quotes/search',
  requestEncoding: 'form-urlencoded',
  input: z.object({
    fromAirportId: z.string(),
    categories: z.array(z.string()),
  }),
  request: {
    'from airport id': '${args.fromAirportId}',
    'aircraft[categories]': '${args.categories}',
  },
  // output and response mapping omitted
},
```

Noodle builds a `URLSearchParams` body: spaces and punctuation in field names are encoded normally, while
each array or nested object is JSON-stringified into its individual form field. Do not pre-encode the body
or set `Content-Type` manually; the connector owns both.

## Run it locally

Before an authorized hosted deployment, inspect this project's inputs with your project-local CLI:
`noodle deploy preflight --org <org> --app weather --env staging --version 1 --json`.
This requires existing hosted access but does not publish or call the weather backend. Its readiness result
does not replace the local and hosted representative-call checks below. Review independent missing bindings,
origin and target-capability findings together before an authorized repair and recheck.

From the repo root, with the workspace built (`pnpm build`):

```bash
: # 1. boot the local loopback dev server
node packages/cli/dist/cli.js dev examples/weather/src/server.ts --app weather

: # 2. in another shell, call the printed local endpoint
URL=http://127.0.0.1:<port>/o/local/weather/dev/mcp
curl -s "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"weather_briefing","arguments":{"city":"Paris"}}}'
```

Example result (live data, abbreviated):

```json
{
  "place": "Paris", "country": "France",
  "temperature_c": 25.1, "windspeed_kmh": 8.3,
  "conditions": "overcast",
  "headline": "Paris, France: 25°C, overcast.",
  "advice": "Comfortable conditions — no special prep needed."
}
```

Try other cities (`Reykjavik`, `Singapore`, `Denver`) to see the conditions and advice change.

Call `search_places` to see the **list-returning** tool — one query, many matches:

```bash
curl -s "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_places","arguments":{"query":"Springfield"}}}'
```

```json
{
  "places": [
    { "id": "4951788", "label": "Springfield, Massachusetts, United States" },
    { "id": "4250542", "label": "Springfield, Illinois, United States" },
    { "id": "4508722", "label": "Springfield, Ohio, United States" }
  ]
}
```
