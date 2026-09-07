export function postgresEpochSeconds(date: Date): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

export function postgresTimestampIsLive(expiresAt: Date): boolean {
  return new Date(expiresAt).getTime() > Date.now();
}
