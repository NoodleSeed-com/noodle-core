export function consoleSignedOutReturnUrl(consoleCallbackUrl: string): string {
  return new URL('/signed-out', consoleCallbackUrl).href;
}
