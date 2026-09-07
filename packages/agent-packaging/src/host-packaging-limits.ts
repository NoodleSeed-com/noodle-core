/** Drift-testable common bounds applied before and after every target adapter. */
export const HOST_PACKAGING_LIMITS = Object.freeze({
  summaryChars: 160,
  proseChars: 4_000,
  keywordChars: 64,
  keywords: 20,
  scenarios: 32,
  screenshots: 5,
  identifierChars: 100,
  pathChars: 240,
  files: 128,
  fileBytes: 1024 * 1024,
  totalFileBytes: 10 * 1024 * 1024,
  assetBytes: 5 * 1024 * 1024,
  totalAssetBytes: 20 * 1024 * 1024,
  imageDimension: 4_096,
});
