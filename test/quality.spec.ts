import { describe, expect, it, vi } from "vitest";

import { eligiblePhoto } from "./factories";
import {
  QUALITY_PROMPT,
  QualityScorer,
  parseQualityResponse,
} from "../src/quality";

const passingComponents = {
  technical: 27,
  subject: 28,
  composition: 17,
  landscape: 12,
  distractions: 4,
  hardRejects: [],
  reasons: ["sharp cattle in a green pasture"],
};

it("requests an explicit hard-reject flag from the vision model", () => {
  expect(QUALITY_PROMPT).toContain(
    "SCORE|technical points|subject points|composition points|landscape points|clean-frame points|hard-reject flag|PASS",
  );
  expect(QUALITY_PROMPT).toContain("Use 0 when there is no hard reject and 1 when there is");
});

describe("parseQualityResponse", () => {
  it("computes a passing score from bounded components", () => {
    const result = parseQualityResponse(passingComponents);

    expect(result).toMatchObject({ total: 88, passed: true });
  });

  it("fails closed when the model reports a hard rejection", () => {
    const result = parseQualityResponse({
      technical: 29,
      subject: 29,
      composition: 18,
      landscape: 14,
      distractions: 5,
      hardRejects: ["cattle are tiny distant details"],
      reasons: [],
    });

    expect(result).toMatchObject({ total: 95, passed: false });
  });

  it("parses JSON from a Workers AI response envelope", () => {
    const result = parseQualityResponse({
      response: JSON.stringify(passingComponents),
    });

    expect(result).toMatchObject({ total: 88, passed: true });
  });

  it("parses a structured object from a Workers AI response envelope", () => {
    const result = parseQualityResponse({ response: passingComponents });

    expect(result).toMatchObject({ total: 88, passed: true });
  });

  it("parses the compact line format returned reliably by the vision model", () => {
    const result = parseQualityResponse({
      response: "SCORE|27|28|17|12|4|PASS",
    });

    expect(result).toMatchObject({
      technical: 27,
      subject: 28,
      composition: 17,
      landscape: 12,
      distractions: 4,
      hardRejects: [],
      total: 88,
      passed: true,
    });
  });

  it("parses the vision model's explicit zero hard-reject flag", () => {
    const result = parseQualityResponse({
      response: "SCORE|30|30|20|15|5|0|PASS",
    });

    expect(result).toMatchObject({
      technical: 30,
      subject: 30,
      composition: 20,
      landscape: 15,
      distractions: 5,
      hardRejects: [],
      total: 100,
      passed: true,
    });
  });

  it.each([
    "SCORE|30|30|20|15|5|1|PASS",
    "SCORE|30|30|20|15|5|0|REJECT",
  ])("rejects a contradictory hard-reject flag in %s", (response) => {
    expect(parseQualityResponse(response)).toBeNull();
  });

  it("fails a compact score carrying the model's hard-reject marker", () => {
    const result = parseQualityResponse("SCORE|30|30|20|15|5|REJECT");

    expect(result).toMatchObject({ total: 100, passed: false });
  });

  it("accepts a compact score with a terminal line ending", () => {
    const result = parseQualityResponse("SCORE|27|28|17|12|4|PASS\n");

    expect(result).toMatchObject({ total: 88, passed: true });
  });

  it("rejects unexpected fields after unwrapping a Workers AI response", () => {
    const result = parseQualityResponse({
      response: JSON.stringify({
        ...passingComponents,
        total: 100,
      }),
    });

    expect(result).toBeNull();
  });

  it("passes at the exact quality threshold of 75", () => {
    const result = parseQualityResponse({
      technical: 24,
      subject: 23,
      composition: 15,
      landscape: 10,
      distractions: 3,
      hardRejects: [],
      reasons: ["meets the quality bar"],
    });

    expect(result).toMatchObject({ total: 75, passed: true });
  });

  it("fails immediately below the quality threshold at 74", () => {
    const result = parseQualityResponse({
      technical: 24,
      subject: 22,
      composition: 15,
      landscape: 10,
      distractions: 3,
      hardRejects: [],
      reasons: ["just below the quality bar"],
    });

    expect(result).toMatchObject({ total: 74, passed: false });
  });

  it.each([
    null,
    { technical: 31 },
    { ...passingComponents, technical: "27" },
    {
      technical: 27,
      subject: 28,
      composition: 17,
      landscape: 12,
      distractions: 4,
    },
    { ...passingComponents, technical: 30.5 },
    { ...passingComponents, hardRejects: [3] },
    { ...passingComponents, reasons: "looks good" },
    { response: "not json" },
    { response: "SCORE|28|24|18|12|5|PASS\nextra prose" },
    { response: "SCORE|31|24|18|12|5|PASS" },
    { response: "SCORE|28|24|18|12|5|MAYBE" },
  ])("rejects malformed output %j", (value) => {
    expect(parseQualityResponse(value)).toBeNull();
  });
});

describe("QualityScorer", () => {
  it("scores fetched preview bytes with deterministic vision settings", async () => {
    const run = vi.fn().mockResolvedValue({ response: "SCORE|27|28|17|12|4|0|PASS" });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([12, 34, 56]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const scorer = new QualityScorer({ run } as unknown as Pick<Ai, "run">, fetcher);

    const result = await scorer.score(eligiblePhoto());

    expect(result).toMatchObject({ total: 88, passed: true });
    expect(fetcher).toHaveBeenCalledWith("https://example.com/photos/photo-1/preview.jpg");
    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.2-11b-vision-instruct",
      expect.objectContaining({
        image: [12, 34, 56],
        prompt: QUALITY_PROMPT,
        temperature: 0,
        max_tokens: 32,
      }),
    );
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty("response_format");
  });

  it("reports a parse-stage failure without exposing image data", async () => {
    const run = vi.fn().mockResolvedValue({ response: "unexpected output" });
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const reportFailure = vi.fn();
    const scorer = new QualityScorer(
      { run } as unknown as Pick<Ai, "run">,
      fetcher,
      reportFailure,
    );

    await expect(scorer.score(eligiblePhoto())).resolves.toBeNull();
    expect(reportFailure).toHaveBeenCalledWith({
      photoId: "wordpress:234123",
      stage: "parse",
      detail: "Workers AI response did not match the quality schema",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("unexpected output");
  });

  it("returns null when the preview response is unsuccessful", async () => {
    const run = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const reportFailure = vi.fn();
    const scorer = new QualityScorer(
      { run } as unknown as Pick<Ai, "run">,
      fetcher,
      reportFailure,
    );

    await expect(scorer.score(eligiblePhoto())).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith({
      photoId: "wordpress:234123",
      stage: "preview",
      detail: "preview request returned HTTP 503",
    });
  });

  it("returns null when fetching the preview throws", async () => {
    const run = vi.fn();
    const fetcher = vi.fn().mockRejectedValue(new Error("network failure"));
    const reportFailure = vi.fn();
    const scorer = new QualityScorer(
      { run } as unknown as Pick<Ai, "run">,
      fetcher,
      reportFailure,
    );

    await expect(scorer.score(eligiblePhoto())).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith({
      photoId: "wordpress:234123",
      stage: "preview",
      detail: "preview request failed with Error",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("network failure");
  });

  it("returns null when Workers AI throws", async () => {
    const run = vi.fn().mockRejectedValue(new Error("AI quota exceeded"));
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const reportFailure = vi.fn();
    const scorer = new QualityScorer(
      { run } as unknown as Pick<Ai, "run">,
      fetcher,
      reportFailure,
    );

    await expect(scorer.score(eligiblePhoto())).resolves.toBeNull();
    expect(reportFailure).toHaveBeenCalledWith({
      photoId: "wordpress:234123",
      stage: "ai",
      detail: "Workers AI request failed with Error",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("AI quota exceeded");
  });
});
