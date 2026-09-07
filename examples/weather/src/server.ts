import { connector, server, tool, z } from '@noodleseed/one';

// The same Weather Briefing server, authored in TypeScript with the Noodle authoring SDK.
//
// The SDK owns the *manifest*: the tool, its Zod-typed input/output schemas, and the flow — which you
// write as ordinary code in `fulfil` and the SDK records symbolically into ordered steps.
//
// HTTP and compute connectors are authored here too, so the public developer entrypoint is one
// self-contained server.ts. The SDK still compiles this to internal manifest/catalog data for the runtime.

const geocoding = connector('open_meteo_geocoding')
  .version('1.0.0')
  .http({
    baseUrl: 'https://geocoding-api.open-meteo.com',
    allowedOrigins: ['https://geocoding-api.open-meteo.com'],
    operations: {
      search: {
        type: 'read',
        method: 'GET',
        path: '/v1/search',
        query: ['name'],
        input: z.object({ name: z.string() }),
        output: z.object({
          latitude: z.number(),
          longitude: z.number(),
          place: z.string().optional(),
          country: z.string().optional(),
        }),
        response: {
          latitude: '${response.results[0].latitude}',
          longitude: '${response.results[0].longitude}',
          place: '${response.results[0].name}',
          country: '${response.results[0].country}',
        },
      },
      // A LIST-returning read. `${response.results}` binds the WHOLE array verbatim — a
      // variable-length list of place objects — with no pagination (Open-Meteo returns every match in
      // one page). Contrast the `search` op above, which indexes a single element (`results[0]`). To
      // reduce each element to a few fields, narrow it in the `geo_places` compute connector below: a
      // response mapping cannot iterate an array, and a tool's Zod output does not strip fields at
      // runtime.
      search_list: {
        type: 'read',
        method: 'GET',
        path: '/v1/search',
        query: ['name', 'count'],
        // This endpoint is intentionally small; tighten its allowance below the 1 MiB default.
        limits: { maxResponseBytes: 256 * 1024 },
        input: z.object({ name: z.string(), count: z.number().optional() }),
        output: z.object({ results: z.array(z.unknown()).optional() }),
        response: {
          results: '${response.results}',
        },
      },
    },
  });

const forecast = connector('open_meteo_forecast')
  .version('1.0.0')
  .http({
    baseUrl: 'https://api.open-meteo.com',
    allowedOrigins: ['https://api.open-meteo.com'],
    operations: {
      current: {
        type: 'read',
        method: 'GET',
        path: '/v1/forecast?current_weather=true',
        query: ['latitude', 'longitude'],
        input: z.object({ latitude: z.number(), longitude: z.number() }),
        output: z.object({
          temperature: z.number().optional(),
          windspeed: z.number().optional(),
          weathercode: z.number().optional(),
        }),
        response: {
          temperature: '${response.current_weather.temperature}',
          windspeed: '${response.current_weather.windspeed}',
          weathercode: '${response.current_weather.weathercode}',
        },
      },
    },
  });

const brief = connector('weather_brief')
  .version('1.0.0')
  .compute('summarize', {
    type: 'read',
    input: z.object({
      place: z.string(),
      country: z.string().optional(),
      temperature: z.number(),
      windspeed: z.number(),
      weathercode: z.number(),
    }),
    output: z.object({
      conditions: z.string(),
      headline: z.string(),
      advice: z.string(),
    }),
    // A real function — type-checked here, serialized to source and run in the sandbox. It must be
    // self-contained: no imports, no closure over outer variables, synchronous.
    run: (input) => {
      const codes: Record<number, string> = {
        0: 'clear sky',
        1: 'mainly clear',
        2: 'partly cloudy',
        3: 'overcast',
        45: 'fog',
        48: 'depositing rime fog',
        51: 'light drizzle',
        53: 'moderate drizzle',
        55: 'dense drizzle',
        61: 'slight rain',
        63: 'moderate rain',
        65: 'heavy rain',
        71: 'slight snow',
        73: 'moderate snow',
        75: 'heavy snow',
        77: 'snow grains',
        80: 'slight rain showers',
        81: 'moderate rain showers',
        82: 'violent rain showers',
        85: 'slight snow showers',
        86: 'heavy snow showers',
        95: 'thunderstorm',
        96: 'thunderstorm with hail',
        99: 'thunderstorm with heavy hail',
      };
      const code = Number(input.weathercode);
      const conditions = codes[code] || 'unknown conditions';
      const temp = Math.round(Number(input.temperature));
      const wind = Math.round(Number(input.windspeed));
      const where = input.country ? `${input.place}, ${input.country}` : input.place;
      const headline = `${where}: ${temp}°C, ${conditions}.`;
      const tips: string[] = [];
      if (temp <= 0) tips.push("bundle up, it's freezing");
      else if (temp <= 10) tips.push('wear a warm coat');
      else if (temp >= 28) tips.push("stay hydrated, it's hot");
      if (code >= 95) tips.push('thunderstorms expected — seek shelter');
      else if (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82)
        tips.push('snow — dress warm and tread carefully');
      else if (code >= 51 && code <= 82) tips.push('bring an umbrella');
      if (wind >= 30) tips.push('expect strong winds');
      const advice = tips.length
        ? `${tips.join('; ')}.`
        : 'Comfortable conditions — no special prep needed.';
      return { conditions, headline, advice };
    },
  });

// Narrowing a live list to `{ id, label }` summaries is the ONE reshape a response mapping cannot do
// (the `${...}` language has no per-item iteration) and a tool's Zod output does not enforce at runtime
// — so it happens here, in a sandboxed compute connector (a connector is HTTP or compute, not both).
// This also normalizes the no-results case (Open-Meteo omits `results` when nothing matches) to `[]`.
const placeNarrow = connector('geo_places')
  .version('1.0.0')
  .compute('narrow', {
    type: 'read',
    input: z.object({ results: z.unknown().optional() }),
    output: z.object({ places: z.array(z.unknown()) }),
    // Self-contained: no imports, no closure over outer variables, synchronous.
    run: (input) => {
      const raw = input.results;
      const list = Array.isArray(raw) ? raw : [];
      const places = list.map((entry) => {
        const parts = [entry.name, entry.admin1, entry.country].filter(
          (part) => typeof part === 'string' && part.length > 0,
        );
        const id =
          entry.id !== undefined && entry.id !== null
            ? String(entry.id)
            : `${entry.latitude},${entry.longitude}`;
        return { id, label: parts.join(', ') };
      });
      return { places };
    },
  });

export default server(
  'weather_briefing',
  {
    title: 'Weather Briefing',
    version: '1.0.0',
    use: { geo: geocoding, forecast, brief, places: placeNarrow },
    branding: {
      name: 'Weather Briefing',
      accent: '#0284C7',
      radius: 'md',
      density: 'comfortable',
    },
  },
  [
    tool('weather_briefing', {
      title: 'Weather briefing',
      description:
        'Look up a city, fetch its current weather, and return a human-readable briefing. Runs a ' +
        'three-step flow: geocode the city, fetch the forecast, then derive the briefing in a sandboxed compute step.',
      input: z.object({
        city: z.string(),
      }),
      output: z.object({
        place: z.string(),
        country: z.string(),
        temperature_c: z.number(),
        windspeed_kmh: z.number(),
        conditions: z.string(),
        headline: z.string(),
        advice: z.string(),
      }),
      fulfil: ({ input, connectors }) => {
        const located = connectors.geo.search({ name: input.city });
        const weather = connectors.forecast.current({
          latitude: located.latitude,
          longitude: located.longitude,
        });
        const briefing = connectors.brief.summarize({
          place: located.place,
          country: located.country,
          temperature: weather.temperature,
          windspeed: weather.windspeed,
          weathercode: weather.weathercode,
        });
        return {
          place: located.place,
          country: located.country,
          temperature_c: weather.temperature,
          windspeed_kmh: weather.windspeed,
          conditions: briefing.conditions,
          headline: briefing.headline,
          advice: briefing.advice,
        };
      },
    }),
    // A connector that returns a live, variable-length LIST: search a place name, get back the
    // matching locations as `{ id, label }` options the model can resolve against. The HTTP op binds
    // the whole array; the compute connector narrows each element to the two fields the model speaks
    // from. Append new tools AFTER existing ones so `tools[0]` stays stable for host harnesses.
    tool('search_places', {
      title: 'Search places',
      description:
        'Search a place name and return the matching locations as a list of { id, label } options.',
      // Bound the list at the source: `limit` is capped in the schema and passed through to the
      // upstream `count` parameter, so the model can never pull an unbounded page into its context.
      // `noodle check` reports an unbounded array output as `tool_design_output_bounds`.
      input: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      output: z.object({
        places: z.array(z.object({ id: z.string(), label: z.string() })),
      }),
      fulfil: ({ input, connectors }) => {
        const found = connectors.geo.search_list({ name: input.query, count: input.limit });
        const narrowed = connectors.places.narrow({ results: found.results });
        return { places: narrowed.places };
      },
    }),
  ],
);
