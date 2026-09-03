const SLOT_MS = 12 * 60 * 60 * 1000;

export function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function utcSlotStartMs(timestampMs: number): number {
  return Math.floor(timestampMs / SLOT_MS) * SLOT_MS;
}

export function currentUtcSlot(timestampMs: number): string {
  return new Date(utcSlotStartMs(timestampMs)).toISOString();
}

export function nextUtcSlot(timestampMs: number): string {
  return new Date(utcSlotStartMs(timestampMs) + SLOT_MS).toISOString();
}

export function nextUtcSlotDate(timestampMs: number): string {
  return utcDate(utcSlotStartMs(timestampMs) + SLOT_MS);
}

export function secondsUntilNextUtcSlot(timestampMs: number): number {
  const next = utcSlotStartMs(timestampMs) + SLOT_MS;
  return Math.max(1, Math.ceil((next - timestampMs) / 1000));
}
