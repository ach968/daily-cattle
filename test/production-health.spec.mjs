import { describe, expect, it } from "vitest";

import { runProductionHealthCheck } from "../scripts/production-health.mjs";

const SERVICE_URL = "https://daily-cattle.example";
const NOW = new Date("2026-09-02T00:17:00.000Z");

function metadata(overrides = {}) {
  return {
    date: "2026-09-02",
    photoId: "wordpress:123",
    origin: "fresh",
    quality: {
      total: 75,
      passed: true,
      hardRejects: [],
    },
    ...overrides,
  };
}

function fetchMetadata(value) {
  return async (input) => {
    expect(String(input)).toBe(`${SERVICE_URL}/today.json`);
    return Response.json(value);
  };
}

describe("runProductionHealthCheck", () => {
  it("accepts a fresh selection at the 75-point production threshold", async () => {
    await expect(
      runProductionHealthCheck(SERVICE_URL, fetchMetadata(metadata()), NOW),
    ).resolves.toMatchObject({
      date: "2026-09-02",
      photoId: "wordpress:123",
      origin: "fresh",
      score: 75,
    });
  });

  it("accepts a reserve promotion as a new daily selection", async () => {
    await expect(
      runProductionHealthCheck(
        SERVICE_URL,
        fetchMetadata(metadata({ origin: "reserve" })),
        NOW,
      ),
    ).resolves.toMatchObject({ origin: "reserve" });
  });

  it("rejects a retained selection", async () => {
    await expect(
      runProductionHealthCheck(
        SERVICE_URL,
        fetchMetadata(metadata({ origin: "retained" })),
        NOW,
      ),
    ).rejects.toThrow(/retained/);
  });

  it("rejects a selection from a previous UTC day", async () => {
    await expect(
      runProductionHealthCheck(
        SERVICE_URL,
        fetchMetadata(metadata({ date: "2026-09-01" })),
        NOW,
      ),
    ).rejects.toThrow(/not today in UTC/);
  });

  it("rejects a selection below the 75-point production threshold", async () => {
    await expect(
      runProductionHealthCheck(
        SERVICE_URL,
        fetchMetadata(
          metadata({ quality: { total: 74, passed: false, hardRejects: [] } }),
        ),
        NOW,
      ),
    ).rejects.toThrow(/quality gate|below 75/);
  });

  it("rejects an unknown selection origin", async () => {
    await expect(
      runProductionHealthCheck(
        SERVICE_URL,
        fetchMetadata(metadata({ origin: "unknown" })),
        NOW,
      ),
    ).rejects.toThrow(/origin/);
  });
});
