import { describe, expect, it, vi } from "vitest";

import qualityCases from "../benchmark/quality-cases.json";
import { QUALITY_MAX_TOKENS, QUALITY_PROMPT } from "../src/quality";
import { runBenchmark, type BenchmarkCase } from "../scripts/benchmark-quality";

const QUALITY_CASES = qualityCases as BenchmarkCase[];

const EXPECTED_QUALITY_CASES: BenchmarkCase[] = [
  {
    id: "wordpress:234123",
    url: "https://pd.w.org/2026/07/296a697b0475c861.68075092-1024x768.jpg",
    expected: "pass",
  },
  {
    id: "wordpress:220305",
    url: "https://pd.w.org/2026/06/6076a246b8ddf3fd3.71611506-1024x683.jpg",
    expected: "pass",
  },
  {
    id: "wordpress:198387",
    url: "https://pd.w.org/2026/04/37769e3e37fd43491.19488756-1024x576.jpg",
    expected: "pass",
  },
  {
    id: "wordpress:196511",
    url: "https://pd.w.org/2026/04/69469e1010661fbd8.73614172-1024x768.jpeg",
    expected: "pass",
  },
  {
    id: "wordpress:127290",
    url: "https://pd.w.org/2025/04/233680fce5a0a1ad1.29801946-1024x768.jpg",
    expected: "pass",
  },
  {
    id: "wordpress:229505",
    url: "https://pd.w.org/2026/07/1596a528beb5c6349.63443660-1024x576.jpg",
    expected: "reject",
  },
  {
    id: "wordpress:197224",
    url: "https://pd.w.org/2026/04/65269e1cf90255cf9.45959761-1024x576.jpg",
    expected: "reject",
  },
  {
    id: "wordpress:191930",
    url: "https://pd.w.org/2026/04/83269d4a5f89658b2.80974906-1024x575.jpg",
    expected: "reject",
  },
  {
    id: "wordpress:188739",
    url: "https://pd.w.org/2026/03/76069c4c06a96b5b4.65686304-1024x737.jpg",
    expected: "reject",
  },
  {
    id: "wordpress:184877",
    url: "https://pd.w.org/2026/02/8656991addf801346.08343302-1024x965.jpeg",
    expected: "reject",
  },
];

describe("runBenchmark", () => {
  it("uses the ten pre-vetted WordPress preview cases", () => {
    expect(QUALITY_CASES).toEqual(EXPECTED_QUALITY_CASES);
    expect(new Set(QUALITY_CASES.map(({ id }) => id)).size).toBe(10);
    expect(QUALITY_CASES.every(({ id }) => id.startsWith("wordpress:"))).toBe(true);
    expect(QUALITY_CASES.filter(({ expected }) => expected === "pass")).toHaveLength(5);
    expect(QUALITY_CASES.filter(({ expected }) => expected === "reject")).toHaveLength(5);
    expect(QUALITY_CASES.every(({ url }) => new URL(url).hostname === "pd.w.org")).toBe(true);
    expect(QUALITY_CASES.some(({ url }) => new URL(url).hostname.includes("flickr"))).toBe(false);
  });

  it("uses the production prompt and reports a matching classification", async () => {
    const benchmarkCase: BenchmarkCase = {
      id: "cow-1",
      url: "https://images.example/cow.jpg",
      expected: "pass",
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === benchmarkCase.url) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }

      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/account-1/ai/run/@cf/meta/llama-3.2-11b-vision-instruct",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        image: [1, 2, 3],
        prompt: QUALITY_PROMPT,
        temperature: 0,
        max_tokens: QUALITY_MAX_TOKENS,
      });
      return Response.json({ result: { response: "SCORE|27|28|17|12|4|PASS" } });
    });
    const log = vi.fn();

    await expect(
      runBenchmark([benchmarkCase], {
        accountId: "account-1",
        apiToken: "secret-token",
        fetcher: fetcher as typeof fetch,
        log,
      }),
    ).resolves.toBe(true);

    expect(log).toHaveBeenCalledWith("cow-1 expected=pass actual=pass score=88 MATCH");
  });

  it("fails closed on malformed AI output without logging the token", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(Response.json({ result: { response: "not json" } }));
    const log = vi.fn();

    await expect(
      runBenchmark(
        [{ id: "cow-2", url: "https://images.example/cow.jpg", expected: "pass" }],
        {
          accountId: "account-1",
          apiToken: "do-not-print-me",
          fetcher: fetcher as typeof fetch,
          log,
        },
      ),
    ).resolves.toBe(false);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(" ")).not.toContain("do-not-print-me");
  });

  it("redacts the API token from arbitrary fetch errors", async () => {
    const token = "embedded-secret-token";
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error(`upstream exposed ${token} twice: ${token}`));
    const log = vi.fn();

    await expect(
      runBenchmark(
        [{ id: "cow-3", url: "https://images.example/cow.jpg", expected: "pass" }],
        {
          accountId: "account-1",
          apiToken: token,
          fetcher: fetcher as typeof fetch,
          log,
        },
      ),
    ).resolves.toBe(false);

    const output = log.mock.calls.flat().join(" ");
    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED]");
  });
});
