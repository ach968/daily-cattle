import { describe, expect, it } from "vitest";
import { nextUtcDate, secondsUntilNextUtcMidnight, utcDate } from "../src/day";

describe("UTC day helpers", () => {
  const time = Date.parse("2026-08-26T23:59:30.000Z");

  it("formats the current and next UTC dates", () => {
    expect(utcDate(time)).toBe("2026-08-26");
    expect(nextUtcDate(time)).toBe("2026-08-27");
  });

  it("calculates a positive cache lifetime ending at midnight", () => {
    expect(secondsUntilNextUtcMidnight(time)).toBe(30);
    expect(secondsUntilNextUtcMidnight(Date.parse("2026-08-26T00:00:00Z"))).toBe(86400);
  });
});
