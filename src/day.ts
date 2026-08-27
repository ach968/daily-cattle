export function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function nextUtcDate(timestampMs: number): string {
  return utcDate(timestampMs + 86_400_000);
}

export function secondsUntilNextUtcMidnight(timestampMs: number): number {
  const now = new Date(timestampMs);
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - timestampMs) / 1000));
}
