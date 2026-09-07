const CREDENTIAL_SHAPED_TEXT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;

/** Catch common credential shapes even when a connector returns them under an innocuous key. */
export function isCredentialShapedAssistantText(value: string): boolean {
  return CREDENTIAL_SHAPED_TEXT.test(value);
}
