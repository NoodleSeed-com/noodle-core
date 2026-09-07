import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildMcpServer, type ProtocolRequestContext, type ServedArtifact } from './sdk-server.js';

/**
 * Serve a single already-parsed JSON-RPC request for one {@link ServedArtifact} over the MCP
 * **Streamable HTTP** transport, statelessly. A fresh SDK server + transport are built per request
 * (`sessionIdGenerator: undefined`), so no session state is retained between calls; `enableJsonResponse`
 * returns one `application/json` JSON-RPC response rather than an SSE stream. The transport owns version
 * negotiation and framing; the caller's HTTP front-door owns origin/method/size guards.
 *
 * `parsedBody` is the JSON already read by the front-door (so its body-size guard still applies). The
 * transport writes the full HTTP response (status + headers + body), including `202` for a notification.
 */
export async function handleStatelessHttp(
  target: ServedArtifact,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  context: ProtocolRequestContext = {},
): Promise<void> {
  // A nested `elicitation/create` request cannot complete on this lane: JSON-response mode withholds
  // the body until the original tool response is ready, while the client's elicitation response would
  // arrive on a later POST with no durable session coordinator to route it back to this pending server.
  // Mark that boundary explicitly so eliciting tools fail closed instead of deadlocking until timeout.
  const server = buildMcpServer(target, {
    ...context,
    formElicitationTransport: 'unavailable',
  });
  // Omitting `sessionIdGenerator` selects stateless mode; `enableJsonResponse` returns one JSON-RPC
  // object rather than an SSE stream. (We can't pass `sessionIdGenerator: undefined` explicitly under
  // `exactOptionalPropertyTypes`.)
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  // The SDK transport's optional `onclose`/`onerror`/`onmessage` are `T | undefined`, which trips
  // `exactOptionalPropertyTypes` against the `Transport` interface; it is a valid Transport at runtime.
  await server.connect(transport as Transport);
  await transport.handleRequest(req, res, parsedBody);
}
