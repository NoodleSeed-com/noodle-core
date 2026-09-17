export const WEB_EXTRACT_LIMITS = {
  maxUrls: 5,
  maxCalls: 3,
  maxConcurrency: 2,
  maxPageBytes: 1024 * 1024,
  maxTextBytes: 32 * 1024,
  maxTurnTextBytes: 128 * 1024,
  maxRobotsBytes: 512 * 1024,
  maxUrlCharacters: 2048,
  maxLinks: 30,
  maxRedirects: 2,
  maxHttpAttempts: 20,
  timeoutMs: 30_000,
} as const;
