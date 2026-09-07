// Canonical committed-secret/token regexes. Single source of truth, imported by both the
// whole-tree docs scan (scripts/check-docs.mjs) and the fast staged-file pre-commit scan
// (scripts/dev-gate.mjs). See ADR 0091. Keep patterns global-flagged (`g`) for matchAll().
export const SECRET_PATTERNS = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}['"]\s*\+\s*['"][A-Za-z0-9_-]{8,}\b/g,
  /\bpplx-[A-Za-z0-9]{20,}\b/g,
  /\bCFPAT-[A-Za-z0-9_-]{20,}\b/g,
];
