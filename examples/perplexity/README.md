# Perplexity Grounding — owner-only current-knowledge MCP server

This curated example wraps Perplexity as a small, generic grounding server for coding agents and other MCP
clients that need current, cited web answers instead of stale model knowledge. The tool surface is intentionally
domain-neutral: callers provide the query, messages, instructions, domains, recency, and date filters needed
for their narrow task.

The public developer entrypoint is [`src/server.ts`](src/server.ts). It uses a managed bearer secret; API keys never
belong in source, generated manifests, runtime artifacts, prompts, or logs.

There are two separate credentials in this example:

- The **Perplexity API key** is a managed Noodle Seed secret used only by the server when calling Perplexity.
- The **MCP OAuth session** is the user's Noodle Seed Cloud sign-in for the owner-only MCP endpoint. Refresh
  token failures here are platform OAuth issues, not Perplexity API-key issues.

## Provision

1. Create a Perplexity API key for Sonar, Search, async Sonar, and Agent access.
2. Export the value only in your shell while configuring Noodle Seed Cloud:

```bash
export PERPLEXITY_API_KEY='pplx-...'
```

## Validate

```bash
noodle validate examples/perplexity/src/server.ts
```

## Deploy owner-only to Noodle Seed Cloud

The intended personal hosted target is `fahdrafi/perplexity/prod`.

```bash
noodle orgs create fahdrafi --display-name "Fahd Rafi"
noodle target set --runtime cloud --org fahdrafi --app perplexity --env prod
noodle secrets set PERPLEXITY_API_KEY --scope env --from-env PERPLEXITY_API_KEY
noodle deploy examples/perplexity/src/server.ts --org fahdrafi --app perplexity --env prod --access owner-only
```

Endpoint:

```text
https://cloud.noodleseed.dev/o/fahdrafi/perplexity/prod/mcp
```

## Tools

- `search`: current ranked source search through Perplexity Search.
- `answer`: synchronous Sonar answer with citations, search results, optional images, and related questions.
- `research`: generic non-streaming Agent API request with caller-provided model, preset, tools, reasoning,
  output format, and instructions.
- `start_research`: submit an asynchronous Sonar research request, defaulting to `sonar-deep-research`.
- `get_research`: poll one asynchronous Sonar research request.
- `list_research`: list asynchronous Sonar research requests.

## Deliberate exclusions

- Streaming/SSE is not exposed in this v1 because Noodle's current declarative HTTP connector surface is
  JSON `GET`/`POST`, not streaming response delivery.
- Embeddings, model listing, Computer analytics, and API-key lifecycle endpoints are omitted from the public
  MCP tool surface. This example is a current-knowledge grounding server, not a broad vendor API wrapper.

## Manual smoke

After deploy, connect the endpoint from Claude.ai or ChatGPT and sign in with the deployer's Noodle Seed
Cloud account. Verify an unauthenticated MCP request gets a `401`, then call:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Find the current official docs for the Model Context Protocol initialize request and summarize the required fields."
    }
  ],
  "model": "sonar",
  "search_domain_filter": ["modelcontextprotocol.io"],
  "return_related_questions": true
}
```
