import { describe, expect, it } from "vitest";
import {
  currentUtcSlot,
  nextUtcSlot,
  nextUtcSlotDate,
  secondsUntilNextUtcSlot,
  utcDate,
} from "../src/day";

describe("UTC slot helpers", () => {
  it.each([
    ["2026-08-26T11:45:00.000Z", "2026-08-26T00:00:00.000Z", "2026-08-26T12:00:00.000Z", "2026-08-26"],
    ["2026-08-26T23:45:00.000Z", "2026-08-26T12:00:00.000Z", "2026-08-27T00:00:00.000Z", "2026-08-27"],
  ])("maps %s to its current and next slots", (time, current, next, nextDate) => {
    const timestamp = Date.parse(time);

    expect(utcDate(timestamp)).toBe("2026-08-26");
    expect(currentUtcSlot(timestamp)).toBe(current);
    expect(nextUtcSlot(timestamp)).toBe(next);
    expect(nextUtcSlotDate(timestamp)).toBe(nextDate);
  });

  it("calculates cache lifetimes ending at the next 12-hour boundary", () => {
    expect(secondsUntilNextUtcSlot(Date.parse("2026-08-26T11:59:30Z"))).toBe(30);
    expect(secondsUntilNextUtcSlot(Date.parse("2026-08-26T12:00:00Z"))).toBe(43_200);
    expect(secondsUntilNextUtcSlot(Date.parse("2026-08-26T23:59:30Z"))).toBe(30);
  });
});
