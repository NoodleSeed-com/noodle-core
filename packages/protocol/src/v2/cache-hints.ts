import type { CacheHint } from '@modelcontextprotocol/server';

const PRIVATE_UNFRESH: CacheHint = {
  ttlMs: 0,
  cacheScope: 'private',
};

/** Conservative defaults: authorization-aware callers can never cross a cache partition. */
export const NOODLE_MCP_CACHE_HINTS = {
  'server/discover': PRIVATE_UNFRESH,
  'tools/list': PRIVATE_UNFRESH,
  'prompts/list': PRIVATE_UNFRESH,
  'resources/list': PRIVATE_UNFRESH,
  'resources/templates/list': PRIVATE_UNFRESH,
  'resources/read': PRIVATE_UNFRESH,
} as const;
