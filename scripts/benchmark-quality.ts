import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  QUALITY_MAX_TOKENS,
  QUALITY_PROMPT,
  parseQualityResponse,
} from "../src/quality";

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const CASES_URL = new URL("../benchmark/quality-cases.json", import.meta.url);

export interface BenchmarkCase {
  id: string;
  url: string;
  expected: "pass" | "reject";
}

export interface BenchmarkOptions {
  accountId: string;
  apiToken: string;
  fetcher?: typeof fetch;
  log?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBenchmarkCase(value: unknown): value is BenchmarkCase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    (value.expected === "pass" || value.expected === "reject")
  );
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[REDACTED]") : message;
}

async function loadCases(): Promise<BenchmarkCase[]> {
  const value: unknown = JSON.parse(await readFile(CASES_URL, "utf8"));
  if (!Array.isArray(value) || value.length !== 10 || !value.every(isBenchmarkCase)) {
    throw new Error("benchmark/quality-cases.json must contain ten valid cases");
  }
  return value;
}

async function scoreCase(
  benchmarkCase: BenchmarkCase,
  options: Required<Pick<BenchmarkOptions, "accountId" | "apiToken">> & {
    fetcher: typeof fetch;
  },
) {
  const preview = await options.fetcher(benchmarkCase.url);
  if (!preview.ok) {
    throw new Error(`preview request returned HTTP ${preview.status}`);
  }

  const image = Array.from(new Uint8Array(await preview.arrayBuffer()));
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}` +
    `/ai/run/${VISION_MODEL}`;
  const response = await options.fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image,
      prompt: QUALITY_PROMPT,
      temperature: 0,
      max_tokens: QUALITY_MAX_TOKENS,
    }),
  });
  if (!response.ok) {
    throw new Error(`Workers AI request returned HTTP ${response.status}`);
  }

  const envelope: unknown = await response.json();
  const result = isRecord(envelope) ? envelope.result : null;
  const assessment = parseQualityResponse(result);
  if (!assessment) {
    throw new Error("Workers AI returned an invalid quality response");
  }
  return assessment;
}

export async function runBenchmark(
  cases: BenchmarkCase[],
  options: BenchmarkOptions,
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? console.log;
  let allMatch = true;

  for (const benchmarkCase of cases) {
    try {
      const assessment = await scoreCase(benchmarkCase, {
        accountId: options.accountId,
        apiToken: options.apiToken,
        fetcher,
      });
      const actual = assessment.passed ? "pass" : "reject";
      const matches = actual === benchmarkCase.expected;
      allMatch &&= matches;
      log(
        `${benchmarkCase.id} expected=${benchmarkCase.expected} actual=${actual} ` +
          `score=${assessment.total} ${matches ? "MATCH" : "MISMATCH"}`,
      );
    } catch (error: unknown) {
      allMatch = false;
      const rawMessage = error instanceof Error ? error.message : "unknown error";
      const message = redactSecret(rawMessage, options.apiToken);
      log(
        `${benchmarkCase.id} expected=${benchmarkCase.expected} actual=error ` +
          `score=n/a MISMATCH (${message})`,
      );
    }
  }

  return allMatch;
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
    );
  }

  const matches = await runBenchmark(await loadCases(), { accountId, apiToken });
  if (!matches) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(() => {
    console.error("benchmark failed; check credentials, manifest, and network access");
    process.exitCode = 1;
  });
}
