# Flickr Cattle Picture-of-the-Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a free Cloudflare Worker whose stable `/today` URL returns one automatically selected, high-quality, openly licensed Flickr cattle-in-pasture photograph per UTC day.

**Architecture:** A TypeScript Worker uses Flickr's search and size APIs for discovery, Workers AI for a fixed visual-quality gate, Workers KV for current/next/reserve metadata, and the Cache API for daily image responses. Separate pure modules implement discovery, scoring, state transitions, and HTTP serving so each boundary can be tested with mocked dependencies before live Cloudflare setup.

**Tech Stack:** Node.js 22+, TypeScript, Cloudflare Workers, Wrangler, Workers KV, Workers AI (`@cf/meta/llama-3.2-11b-vision-instruct`), Vitest 4.1+, `@cloudflare/vitest-plugin`

**Spec:** `docs/superpowers/specs/2026-08-26-flickr-cattle-picture-of-day-design.md`

## Global Constraints

- Use UTC for all selection dates, preparation, promotion, and cache expiry.
- Serve the untouched Flickr source; never resize, crop, recompress, or upscale it.
- Require native width at least 1920, native height at least 1080, and width greater than height.
- Permit only CC BY, CC BY-SA, CC0, and public-domain Flickr licenses.
- Require a quality score of at least 82; never lower the threshold after failures or quota exhaustion.
- Evaluate at most 20 Workers AI previews per daily preparation run by default.
- Maintain one current image, one prepared next image, at most nine reserves, and the last 30 served Flickr IDs.
- Store metadata in KV but never store image bytes in KV or permanent object storage.
- Keep runtime dependencies within Cloudflare's free tier.
- Keep TypeScript in strict mode and model external API data as `unknown` until validated.

---

## Planned File Structure

- `package.json` — scripts and development dependencies
- `tsconfig.json` — strict TypeScript configuration
- `vitest.config.ts` — Workers Vitest plugin and local KV binding
- `wrangler.jsonc` — Worker, AI, KV, observability, and UTC Cron bindings
- `src/config.ts` — fixed policy constants and Flickr tag searches
- `src/model.ts` — shared domain types and dependency interfaces
- `src/day.ts` — UTC date and cache-lifetime helpers
- `src/flickr.ts` — Flickr API client, validation, license mapping, and source resolution
- `src/quality.ts` — Workers AI prompt, response validation, and score calculation
- `src/state.ts` — KV serialization and schema validation
- `src/selector.ts` — candidate exclusion, evaluation, ranking, and reserve refill
- `src/lifecycle.ts` — prepare, promote, retain, and emergency fallback transitions
- `src/http.ts` — `/today`, `/today.json`, upstream streaming, and daily cache
- `src/index.ts` — Worker `fetch` and `scheduled` entrypoints
- `test/factories.ts` — shared deterministic photo, score, state, KV, Flickr, and AI test doubles
- `test/*.spec.ts` — unit and integration tests organized by responsibility
- `benchmark/quality-cases.json` — fixed Flickr preview benchmark and expected outcome
- `scripts/benchmark-quality.ts` — optional live Workers AI benchmark
- `scripts/smoke.mjs` — deployed endpoint consistency checks
- `README.md` — setup, secrets, deployment, operation, and attribution behavior

---

### Task 1: Project Foundation and UTC Helpers

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `src/config.ts`
- Create: `src/model.ts`
- Create: `src/day.ts`
- Create: `test/factories.ts`
- Create: `test/day.spec.ts`

**Interfaces:**
- Produces: `utcDate(timestampMs): string`, `nextUtcDate(timestampMs): string`, `secondsUntilNextUtcMidnight(timestampMs): number`
- Produces: all domain types used by later tasks, including `EligiblePhoto`, `QualityAssessment`, `SelectionEntry`, `ServiceState`, and `AppEnv`

- [ ] **Step 1: Create the package and Worker configuration**

Create `package.json` with no runtime dependencies and these scripts:

```json
{
  "name": "cattle-pic",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "wrangler dev",
    "cf-typegen": "wrangler types",
    "benchmark": "tsx scripts/benchmark-quality.ts",
    "smoke": "node scripts/smoke.mjs",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "latest",
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "^4.1.0",
    "wrangler": "latest"
  }
}
```

Create `wrangler.jsonc` with compatibility date `2026-08-26`, AI binding `AI`, KV binding `STATE`, observability enabled, and Cron expressions `45 23 * * *` and `0 0 * * *`. Use `local-development-only` as the KV ID until Task 8 replaces it with Wrangler's generated production ID.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cattle-pic",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-26",
  "observability": { "enabled": true },
  "ai": { "binding": "AI" },
  "kv_namespaces": [
    { "binding": "STATE", "id": "local-development-only" }
  ],
  "triggers": {
    "crons": ["45 23 * * *", "0 0 * * *"]
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/vitest-plugin"]
  },
  "include": ["worker-configuration.d.ts", "src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { kvNamespaces: ["STATE"] },
    }),
  ],
});
```

- [ ] **Step 2: Install dependencies and generate Cloudflare types**

Run:

```bash
npm install
npm run cf-typegen
```

Expected: `node_modules/`, `package-lock.json`, and `worker-configuration.d.ts` are created without errors.

- [ ] **Step 3: Define policy constants and domain types**

In `src/config.ts`, define these exact exports:

```ts
export const QUALITY_THRESHOLD = 82;
export const MAX_DAILY_EVALUATIONS = 20;
export const MAX_RESERVES = 9;
export const MAX_RECENT_IDS = 30;
export const RECENT_WINDOW_DAYS = 180;
export const STATE_KEY = "service-state:v1";
export const PREPARE_CRON = "45 23 * * *";
export const PROMOTE_CRON = "0 0 * * *";
export const TAG_PAIRS = [
  ["cow", "pasture"],
  ["cattle", "grazing"],
  ["cows", "meadow"],
  ["cattle", "grass"],
  ["livestock", "pasture"],
] as const;
```

In `src/model.ts`, define the shared shapes:

```ts
export type AllowedLicense = "CC BY" | "CC BY-SA" | "CC0" | "Public Domain";
export type SelectionOrigin = "fresh" | "reserve" | "retained";

export interface EligiblePhoto {
  photoId: string;
  title: string;
  photographer: string;
  photographerUrl: string;
  pageUrl: string;
  license: AllowedLicense;
  licenseUrl: string;
  sourceUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface QualityAssessment {
  technical: number;
  subject: number;
  composition: number;
  landscape: number;
  distractions: number;
  total: number;
  passed: boolean;
  hardRejects: string[];
  reasons: string[];
}

export interface SelectionEntry extends EligiblePhoto {
  quality: QualityAssessment;
  scoredAt: string;
  intendedDate: string;
  origin: SelectionOrigin;
}

export interface RunOutcome {
  at: string;
  status: "success" | "fallback" | "failed";
  detail: string;
}

export interface ServiceState {
  schemaVersion: 1;
  current?: SelectionEntry;
  next?: SelectionEntry;
  reserve: SelectionEntry[];
  recentPhotoIds: string[];
  lastPreparation?: RunOutcome;
  lastPromotion?: RunOutcome;
}

export interface AppEnv {
  STATE: KVNamespace;
  AI: Ai;
  FLICKR_API_KEY: string;
}
```

Create `test/factories.ts` with deterministic factories `eligiblePhoto(overrides?: Partial<EligiblePhoto>): EligiblePhoto`, `quality(overrides?: Partial<QualityAssessment>): QualityAssessment`, `entry(overrides?: Partial<SelectionEntry>): SelectionEntry`, and `serviceState(overrides?: Partial<ServiceState>): ServiceState`. Use fixed defaults (`photo-1`, `2026-08-26`, 4032x3024, CC0, total 90) and object spreads so later tests override only fields relevant to the behavior under test.

- [ ] **Step 4: Write failing UTC helper tests**

Create `test/day.spec.ts`:

```ts
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
```

- [ ] **Step 5: Run the test and verify it fails**

Run: `npm test -- test/day.spec.ts`

Expected: FAIL because `src/day.ts` does not exist.

- [ ] **Step 6: Implement the UTC helpers**

```ts
export function utcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function nextUtcDate(timestampMs: number): string {
  return utcDate(timestampMs + 86_400_000);
}

export function secondsUntilNextUtcMidnight(timestampMs: number): number {
  const now = new Date(timestampMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - timestampMs) / 1000));
}
```

- [ ] **Step 7: Verify the foundation**

Run:

```bash
npm test -- test/day.spec.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc worker-configuration.d.ts src/config.ts src/model.ts src/day.ts test/factories.ts test/day.spec.ts
git commit -m "chore: scaffold cattle picture worker"
```

---

### Task 2: Flickr Discovery and Hard Gates

**Files:**
- Create: `src/flickr.ts`
- Create: `test/flickr.spec.ts`

**Interfaces:**
- Consumes: `EligiblePhoto`, `AllowedLicense`, `TAG_PAIRS`, `RECENT_WINDOW_DAYS`
- Produces: `FlickrClient.search(nowMs, allDates): Promise<FlickrSearchPhoto[]>`
- Produces: `FlickrClient.resolve(photo): Promise<EligiblePhoto | null>`
- Produces: `FlickrClient.isAvailable(photo): Promise<boolean>`

- [ ] **Step 1: Write Flickr response fixtures and failing tests**

Define and export this normalized search shape in `src/flickr.ts`:

```ts
export interface FlickrSearchPhoto {
  id: string;
  owner: string;
  ownername: string;
  pathalias?: string;
  title: string;
  license: string;
}
```

Define test-local factories in `test/flickr.spec.ts` with signatures `searchPhoto(overrides?: Partial<FlickrSearchPhoto>): FlickrSearchPhoto`, `mockFetchForSizes(sizes: unknown): typeof fetch`, `clientWithSingleSize(dimensions: { width: number; height: number }): FlickrClient`, and `captureSearchCalls(): { fetch: typeof fetch; params: URLSearchParams[] }`. Each mock must return real `Response` objects rather than casting plain objects.

In `test/flickr.spec.ts`, mock `fetch` and cover:

```ts
it("resolves the largest downloadable landscape source", async () => {
  const client = new FlickrClient(mockFetchForSizes({
    candownload: 1,
    size: [
      { label: "Large", width: 1024, height: 768, source: "https://img/large.jpg" },
      { label: "Original", width: 4032, height: 3024, source: "https://img/original.jpg" },
    ],
  }), "api-key");

  const photo = await client.resolve(searchPhoto({ id: "123", license: "9" }));
  expect(photo).toMatchObject({
    photoId: "123",
    license: "CC0",
    sourceUrl: "https://img/original.jpg",
    width: 4032,
    height: 3024,
  });
});

it.each([
  [{ width: 1919, height: 1080 }, "undersized width"],
  [{ width: 1920, height: 1079 }, "undersized height"],
  [{ width: 1920, height: 2560 }, "portrait"],
])("rejects %s", async (dimensions) => {
  const client = clientWithSingleSize(dimensions);
  expect(await client.resolve(searchPhoto())).toBeNull();
});

it("uses tag_mode all and only approved Flickr license IDs", async () => {
  const calls = captureSearchCalls();
  const client = new FlickrClient(calls.fetch, "api-key");
  await client.search(Date.parse("2026-08-26T12:00:00Z"), false);
  expect(calls.params.every((p) => p.get("tag_mode") === "all")).toBe(true);
  expect(calls.params.every((p) => p.get("license") === "4,5,9,10")).toBe(true);
});
```

Also test `candownload: 0`, unknown license IDs, Flickr `stat: "fail"`, malformed JSON, HTTP failure, deduplication, the 180-day `min_upload_date`, and the all-date fallback omitting that parameter.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- test/flickr.spec.ts`

Expected: FAIL because `FlickrClient` is not defined.

- [ ] **Step 3: Implement Flickr URL construction and validation**

In `src/flickr.ts`, use `https://www.flickr.com/services/rest/` and `URLSearchParams`. Search each tag pair with both `date-posted-desc` and `interestingness-desc`, `per_page=100`, `safe_search=1`, `content_type=1`, `media=photos`, `extras=license,owner_name,path_alias`, and `nojsoncallback=1`.

Map license IDs exactly:

```ts
const LICENSES = {
  "4": ["CC BY", "https://creativecommons.org/licenses/by/2.0/"],
  "5": ["CC BY-SA", "https://creativecommons.org/licenses/by-sa/2.0/"],
  "9": ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  "10": ["Public Domain", "https://creativecommons.org/publicdomain/mark/1.0/"],
} as const;
```

For `getSizes`, sort downloadable still-image entries by `width * height` descending. Choose the first entry satisfying width `>= 1920`, height `>= 1080`, and width `> height`. Choose the largest size at or below 1024 pixels wide as `previewUrl`; use the source itself only if no smaller preview exists.

Reject any response whose shape cannot be validated with explicit type guards.

- [ ] **Step 4: Implement availability revalidation**

`isAvailable(photo)` must issue a `HEAD` request to `photo.sourceUrl`, fall back to `GET` with `Range: bytes=0-0` when HEAD is unsupported, and return `true` only for a successful image response.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
npm test -- test/flickr.spec.ts
npm test
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/flickr.ts test/flickr.spec.ts
git commit -m "feat: discover eligible Flickr cattle photos"
```

---

### Task 3: Workers AI Quality Gate

**Files:**
- Create: `src/quality.ts`
- Create: `test/quality.spec.ts`

**Interfaces:**
- Consumes: `EligiblePhoto`, `QualityAssessment`, `QUALITY_THRESHOLD`
- Produces: `QualityScorer.score(photo): Promise<QualityAssessment | null>`
- Produces: `QUALITY_PROMPT` and `parseQualityResponse(value: unknown): QualityAssessment | null`

- [ ] **Step 1: Write failing parser and scorer tests**

Create `test/quality.spec.ts` with a mock AI runner and preview fetcher:

```ts
it("computes a passing score from bounded components", () => {
  const result = parseQualityResponse({
    technical: 27,
    subject: 28,
    composition: 17,
    landscape: 12,
    distractions: 4,
    hardRejects: [],
    reasons: ["sharp cattle in a green pasture"],
  });
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

it.each([
  null,
  { technical: 31 },
  { technical: "27" },
  { technical: 27, subject: 28, composition: 17, landscape: 12, distractions: 4 },
])("rejects malformed output %j", (value) => {
  expect(parseQualityResponse(value)).toBeNull();
});
```

Test that `score()` fetches the preview, sends byte data to the configured vision model with temperature `0`, limits output tokens, and returns `null` for upstream image or AI failure.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- test/quality.spec.ts`

Expected: FAIL because the quality module does not exist.

- [ ] **Step 3: Implement the fixed quality prompt**

Export a single prompt that instructs the model to return JSON only with the five component scores, `hardRejects`, and `reasons`. Include the exact rejection policy from the spec: non-photographs, machinery or people dominating, insignificant cattle, watermark/text, blur/noise/compression, severe exposure problems, and weak standalone composition.

The prompt must describe each component's maximum score: 30, 30, 20, 15, and 5.

- [ ] **Step 4: Implement strict response parsing**

`parseQualityResponse` must:

1. Accept either an object or a JSON string from `{ response: string }`.
2. Require every field and integer bounds.
3. Compute `total` in code rather than trusting the model.
4. Set `passed` only when total is at least 82 and `hardRejects` is empty.
5. Return `null` for any schema violation.

- [ ] **Step 5: Implement the Workers AI adapter**

Use dependency injection:

```ts
export class QualityScorer {
  constructor(
    private readonly ai: Pick<Ai, "run">,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async score(photo: EligiblePhoto): Promise<QualityAssessment | null> {
    // Fetch preview bytes, invoke the fixed model, and parse strictly.
  }
}
```

Invoke `@cf/meta/llama-3.2-11b-vision-instruct` with the preview bytes, fixed prompt, `temperature: 0`, and `max_tokens: 300`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm test -- test/quality.spec.ts
npm test
npm run typecheck
git add src/quality.ts test/quality.spec.ts
git commit -m "feat: add deterministic cattle photo quality gate"
```

Expected: tests and typecheck pass before the commit.

---

### Task 4: KV State Repository and Selection Engine

**Files:**
- Create: `src/state.ts`
- Create: `src/selector.ts`
- Create: `test/state.spec.ts`
- Create: `test/selector.spec.ts`

**Interfaces:**
- Consumes: `FlickrClient`, `QualityScorer`, policy constants, and domain types
- Produces: `StateRepository.read(): Promise<ServiceState>` and `StateRepository.write(state): Promise<void>`
- Produces: `SelectionEngine.prepare(state, nowMs): Promise<ServiceState>`

- [ ] **Step 1: Write failing state repository tests**

Test missing state, valid state, invalid JSON, wrong schema version, oversized reserve, duplicate photo IDs, and atomic single-key writes:

```ts
it("returns an empty versioned state when KV has no value", async () => {
  const repo = new StateRepository(fakeKv(null));
  await expect(repo.read()).resolves.toEqual({
    schemaVersion: 1,
    reserve: [],
    recentPhotoIds: [],
  });
});

it("writes the complete state to one key", async () => {
  const kv = recordingKv();
  await new StateRepository(kv).write(validState());
  expect(kv.putCalls).toHaveLength(1);
  expect(kv.putCalls[0][0]).toBe("service-state:v1");
});
```

- [ ] **Step 2: Implement strict state parsing and storage**

Reject corrupt persisted state by throwing `StateValidationError`; do not silently reset a non-empty malformed record. Enforce schema version 1, unique current/next/reserve IDs, reserve length at most nine, recent IDs at most 30, valid dates, and finite score components.

- [ ] **Step 3: Write failing selection-engine tests**

Cover:

```ts
it("chooses the highest passing score and keeps the next nine", async () => {
  const engine = engineWithScores([91, 84, 88, 82, 96, 90, 87, 86, 85, 83, 81]);
  const result = await engine.prepare(emptyState(), Date.parse("2026-08-26T23:45:00Z"));
  expect(result.next?.quality.total).toBe(96);
  expect(result.next?.intendedDate).toBe("2026-08-27");
  expect(result.reserve).toHaveLength(9);
  expect(result.reserve.every((p) => p.quality.total >= 82)).toBe(true);
});

it("excludes current, reserved, next, and last-30 IDs before scoring", async () => {
  const { engine, scorer } = engineWithExclusions();
  await engine.prepare(stateWithExcludedIds(), Date.parse("2026-08-26T23:45:00Z"));
  expect(scorer.seenIds).not.toContain("excluded-id");
});

it("evaluates no more than 20 previews", async () => {
  const { engine, scorer } = engineWithCandidates(50);
  await engine.prepare(emptyState(), Date.now());
  expect(scorer.seenIds).toHaveLength(20);
});
```

Also test recent-window search first, all-date retry only when necessary, date-seeded stable tie ordering, reserve availability revalidation, keeping the best nine combined old/new reserves, and unchanged selection state when nothing passes.

- [ ] **Step 4: Implement candidate preparation**

`SelectionEngine.prepare` must:

1. Revalidate existing reserve entries.
2. Search the recent 180-day window.
3. Exclude current, next, reserve, and recent IDs.
4. Resolve hard-gated Flickr sources.
5. Use a deterministic UTC-date hash to break equal search ranks.
6. Evaluate at most 20 previews.
7. Sort passers by total score descending, then deterministic tie rank.
8. Make the best passer `next` for `nextUtcDate(nowMs)`.
9. Combine remaining passers with valid existing reserves and keep the best nine unique entries.
10. Record a success or failed `lastPreparation` outcome.

Only retry with all Flickr dates when the recent search cannot produce a passing `next` candidate.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- test/state.spec.ts test/selector.spec.ts
npm test
npm run typecheck
git add src/state.ts src/selector.ts test/state.spec.ts test/selector.spec.ts
git commit -m "feat: prepare daily selections and reserve state"
```

---

### Task 5: Daily Promotion and Failure Transitions

**Files:**
- Create: `src/lifecycle.ts`
- Create: `test/lifecycle.spec.ts`

**Interfaces:**
- Consumes: `StateRepository`, `SelectionEngine`, `FlickrClient`, `utcDate`
- Produces: `runPreparation(deps, nowMs): Promise<void>`
- Produces: `runPromotion(deps, nowMs): Promise<void>`
- Produces: `promoteAvailableReserve(deps, nowMs): Promise<SelectionEntry | null>`
- Produces: `consoleLogger: OperationalLogger`

Define these dependency interfaces in `src/lifecycle.ts`:

```ts
export interface OperationalLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface LifecycleDeps {
  repository: StateRepository;
  flickr: Pick<FlickrClient, "isAvailable">;
  selector: SelectionEngine;
  logger: OperationalLogger;
}

export type ReservePromotionDeps = Pick<LifecycleDeps, "repository" | "flickr" | "logger">;
```

- [ ] **Step 1: Write failing preparation tests**

Test that preparation writes only a complete successful next state, preserves current on discovery/AI exceptions, and logs a structured failure without clearing reserves.

```ts
it("does not overwrite state when preparation throws", async () => {
  const deps = lifecycleDeps({ selectorError: new Error("AI unavailable") });
  await runPreparation(deps, Date.parse("2026-08-26T23:45:00Z"));
  expect(deps.repository.writeCalls).toHaveLength(0);
  expect(deps.logger.errors[0]).toMatchObject({ event: "preparation_failed" });
});
```

- [ ] **Step 2: Write failing promotion tests**

Cover fresh, reserve, retained, and unavailable-reserve paths:

```ts
it("promotes the prepared candidate for the current UTC date", async () => {
  const deps = lifecycleDeps({ next: entry({ intendedDate: "2026-08-27" }) });
  await runPromotion(deps, Date.parse("2026-08-27T00:00:00Z"));
  expect(deps.saved.current?.origin).toBe("fresh");
  expect(deps.saved.next).toBeUndefined();
});

it("retains yesterday when neither next nor reserve is valid", async () => {
  const deps = lifecycleDeps({ current: entry({ intendedDate: "2026-08-26" }) });
  await runPromotion(deps, Date.parse("2026-08-27T00:00:00Z"));
  expect(deps.saved.current?.photoId).toBe(deps.initial.current?.photoId);
  expect(deps.saved.current?.origin).toBe("retained");
  expect(deps.saved.current?.intendedDate).toBe("2026-08-27");
});
```

Verify that replaced current IDs enter the bounded 30-item recent list and never return to reserve.

- [ ] **Step 3: Implement lifecycle functions**

Preparation delegates to `SelectionEngine.prepare` and writes only after it returns a valid next candidate. Promotion chooses in order:

1. A `next` entry whose intended date equals today.
2. The highest-scoring reserve entry that passes live availability revalidation.
3. The current verified entry, relabeled `retained` for today's date.

`promoteAvailableReserve` removes failed reserve URLs and persists the resulting state before returning.

- [ ] **Step 4: Add structured operational logging**

Use `console.log(JSON.stringify({...}))` and `console.error(JSON.stringify({...}))` with events `preparation_success`, `preparation_failed`, `promotion_fresh`, `promotion_reserve`, `promotion_retained`, and `reserve_unavailable`. Include counts, photo IDs, scores, and reserve depth, but never secrets or image bytes.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- test/lifecycle.spec.ts
npm test
npm run typecheck
git add src/lifecycle.ts test/lifecycle.spec.ts
git commit -m "feat: promote daily images with verified fallbacks"
```

---

### Task 6: Public Image and Metadata Endpoints

**Files:**
- Create: `src/http.ts`
- Create: `test/http.spec.ts`

**Interfaces:**
- Consumes: `StateRepository`, `promoteAvailableReserve`, `secondsUntilNextUtcMidnight`, `ExecutionContext`
- Produces: `handleRequest(request, deps, nowMs): Promise<Response>`

- [ ] **Step 1: Write failing route and metadata tests**

```ts
it("returns metadata matching the current image", async () => {
  const response = await handleRequest(new Request("https://service/today.json"), depsWithCurrent(), NOW);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    date: "2026-08-26",
    photoId: "photo-1",
    origin: "fresh",
    width: 4032,
    height: 3024,
  });
});

it("returns 404 for unknown routes and 503 before bootstrap", async () => {
  expect((await handleRequest(new Request("https://service/nope"), emptyDeps(), NOW)).status).toBe(404);
  expect((await handleRequest(new Request("https://service/today"), emptyDeps(), NOW)).status).toBe(503);
});
```

- [ ] **Step 2: Write failing image-stream and cache tests**

Verify that `/today`:

- Uses a cache key containing UTC date and photo ID.
- Fetches the exact stored `sourceUrl`.
- Preserves source bytes and `Content-Type`.
- Adds `Access-Control-Allow-Origin: *`.
- Adds `Link` relations for `describedby` and `canonical`.
- Sets `Cache-Control` to the seconds remaining before UTC midnight.
- Uses an upstream ETag or a deterministic fallback ETag.
- Never calls Image Resizing or changes the body.

```ts
it("streams the untouched upstream bytes", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const response = await handleRequest(
    new Request("https://service/today"),
    depsWithUpstream(bytes, "image/jpeg"),
    NOW,
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
});
```

- [ ] **Step 3: Write failing request-time fallback tests**

Test one transient retry, verified reserve promotion after persistent Flickr failure, cache invalidation after promotion, and a `502` response when no checked image is available.

- [ ] **Step 4: Implement `handleRequest`**

Inject repository, cache, fetcher, fallback promoter, logger, and execution context through a `RequestDeps` interface. Keep the request path free of discovery and Workers AI calls.

Use an internal cache URL shaped as:

```ts
const cacheKey = new Request(
  `${new URL(request.url).origin}/_cache/image/${state.current.intendedDate}/${state.current.photoId}`,
);
```

Call `ctx.waitUntil(cache.put(cacheKey, response.clone()))` only after a successful image response.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -- test/http.spec.ts
npm test
npm run typecheck
git add src/http.ts test/http.spec.ts
git commit -m "feat: serve daily Flickr image and attribution metadata"
```

---

### Task 7: Worker Wiring and End-to-End Local Tests

**Files:**
- Create: `src/index.ts`
- Create: `test/worker.spec.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: all concrete clients, repositories, lifecycle functions, and HTTP handler
- Produces: default Cloudflare `ExportedHandler<AppEnv>` with `fetch` and `scheduled`

- [ ] **Step 1: Write failing Worker route integration test**

Use `cloudflare:workers` exports and mocked outbound requests to assert that the deployed entrypoint routes `/today.json` and returns 404 elsewhere. Seed the local `STATE` KV before invoking the Worker.

- [ ] **Step 2: Write failing scheduled-handler tests**

Call the exported scheduled handler with controllers whose `cron` values are `45 23 * * *` and `0 0 * * *`. Assert that only the matching lifecycle operation runs. An unknown Cron expression must log and call `controller.noRetry()` without mutating state.

- [ ] **Step 3: Implement the entrypoint**

Construct concrete dependencies once per event:

```ts
export default {
  async fetch(request, env, ctx) {
    const repository = new StateRepository(env.STATE);
    const flickr = new FlickrClient(fetch, env.FLICKR_API_KEY);
    return handleRequest(request, {
      repository,
      cache: caches.default,
      fetcher: fetch,
      ctx,
      promoteReserve: (nowMs) => promoteAvailableReserve({ repository, flickr, logger: consoleLogger }, nowMs),
    }, Date.now());
  },

  async scheduled(controller, env, ctx) {
    const repository = new StateRepository(env.STATE);
    const flickr = new FlickrClient(fetch, env.FLICKR_API_KEY);
    const scorer = new QualityScorer(env.AI, fetch);
    const selector = new SelectionEngine(flickr, scorer);
    const deps = { repository, flickr, selector, logger: consoleLogger };

    if (controller.cron === PREPARE_CRON) ctx.waitUntil(runPreparation(deps, controller.scheduledTime));
    else if (controller.cron === PROMOTE_CRON) ctx.waitUntil(runPromotion(deps, controller.scheduledTime));
    else controller.noRetry();
  },
} satisfies ExportedHandler<AppEnv>;
```

Keep request-time dependencies free of Workers AI so ordinary image traffic cannot consume AI quota.

- [ ] **Step 4: Exercise local scheduled routes**

Run `npm run dev`, then in a second terminal run:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+23+*+*+*&time=1787787900000&format=json"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+0+*+*+*&time=1787788800000&format=json"
```

Expected: both responses report `"outcome":"ok"`. Use mocked AI in automated tests; local live AI requires Cloudflare login and consumes the free AI allocation.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: all unit and integration tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/worker.spec.ts wrangler.jsonc
git commit -m "feat: wire Worker routes and UTC cron jobs"
```

---

### Task 8: Quality Benchmark, Deployment, and Smoke Test

**Files:**
- Create: `benchmark/quality-cases.json`
- Create: `scripts/benchmark-quality.ts`
- Create: `scripts/smoke.mjs`
- Create: `README.md`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: `parseQualityResponse`, the fixed quality prompt, Cloudflare REST credentials, and deployed endpoint URL
- Produces: `npm run benchmark`, `npm run smoke`, and complete operator instructions

- [ ] **Step 1: Create the fixed quality benchmark manifest**

Use these openly licensed Flickr previews already reviewed during design:

```json
[
  { "id": "34823388031", "url": "https://live.staticflickr.com/4249/34823388031_9f17b74d26_b.jpg", "expected": "pass" },
  { "id": "34823370171", "url": "https://live.staticflickr.com/4219/34823370171_0fbfcd9426_b.jpg", "expected": "pass" },
  { "id": "5871420058", "url": "https://live.staticflickr.com/6033/5871420058_8845fcd36e_b.jpg", "expected": "pass" },
  { "id": "34144992483", "url": "https://live.staticflickr.com/4222/34144992483_854ae0ae45_b.jpg", "expected": "pass" },
  { "id": "14815964458", "url": "https://live.staticflickr.com/3926/14815964458_b6749f51d9_b.jpg", "expected": "pass" },
  { "id": "6036901243", "url": "https://live.staticflickr.com/6200/6036901243_61a909a5d1_b.jpg", "expected": "reject" },
  { "id": "7483856322", "url": "https://live.staticflickr.com/8009/7483856322_f1079e06e8_b.jpg", "expected": "reject" },
  { "id": "49140110236", "url": "https://live.staticflickr.com/65535/49140110236_3232ebe08e_b.jpg", "expected": "reject" },
  { "id": "51907408017", "url": "https://live.staticflickr.com/65535/51907408017_2ae5b85782_b.jpg", "expected": "reject" },
  { "id": "36997717934", "url": "https://live.staticflickr.com/4490/36997717934_a46527098f_b.jpg", "expected": "reject" }
]
```

The rejection cases cover soft presentation, distant subjects, dated/weak presentation, cattle as insignificant details, and a scene where cattle are too small to function as the subject.

- [ ] **Step 2: Implement the optional live benchmark script**

`scripts/benchmark-quality.ts` must require `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, fetch each preview, call:

```text
POST https://api.cloudflare.com/client/v4/accounts/{account-id}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct
```

with the same prompt and model parameters as `QualityScorer`, parse through `parseQualityResponse`, print one line per case, and exit nonzero unless all ten expected pass/reject outcomes match. It must never print the API token.

- [ ] **Step 3: Write the deployed smoke script**

`scripts/smoke.mjs` must accept `SERVICE_URL`, fetch `/today` twice and `/today.json` once, and assert:

- Both image responses are successful and byte-identical.
- `Content-Type` begins with `image/`.
- CORS, cache, ETag, and both `Link` relations are present.
- Metadata photo ID, date, dimensions, license, and source URL are present.
- Width is at least 1920, height at least 1080, and width exceeds height.
- The canonical Flickr URL in metadata matches the response header.

- [ ] **Step 4: Document account setup and secrets**

In `README.md`, include the exact sequence:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create STATE
npx wrangler secret put FLICKR_API_KEY
npm test
npm run typecheck
npm run deploy
```

After `wrangler kv namespace create STATE`, replace the local-only KV object in `wrangler.jsonc` with the complete binding object printed by Wrangler. Document obtaining a Flickr API key through Flickr's App Garden and accepting the Meta model license with the official Workers AI agreement request before the first benchmark or preparation run.

The README must include this agreement request after the operator exports `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct" \
  -X POST \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"prompt":"agree"}'
```

Document that Cron changes can take up to 15 minutes to propagate and that KV may briefly serve yesterday's selection around midnight.

- [ ] **Step 5: Run the benchmark and tune only the prompt if needed**

Run:

```bash
npm run benchmark
```

Expected: all ten benchmark expectations match. If they do not, change only the fixed prompt wording, rerun `test/quality.spec.ts`, and rerun the benchmark. Do not change the threshold, expected labels, or hard gates to force a pass.

- [ ] **Step 6: Deploy and bootstrap through the scheduled handler**

Deploy with `npm run deploy`. Start `wrangler dev --remote` and invoke the preparation and promotion scheduled routes shown in Task 7 so production KV receives an initial verified state before public use. Stop remote development immediately after both jobs succeed.

- [ ] **Step 7: Run deployed smoke verification**

Export `SERVICE_URL` to the exact `workers.dev` URL printed by the preceding `wrangler deploy`, then run `npm run smoke`.

Expected: the smoke script exits zero and reports one matching image/metadata selection. The subdomain is created by Cloudflare during deployment and therefore comes from Wrangler's deployment output rather than source configuration.

- [ ] **Step 8: Verify the complete project**

Run:

```bash
npm test
npm run typecheck
npm run smoke
git diff --check
```

Expected: all commands pass with `SERVICE_URL` exported for the smoke command.

- [ ] **Step 9: Commit**

```bash
git add benchmark/quality-cases.json scripts/benchmark-quality.ts scripts/smoke.mjs README.md wrangler.jsonc
git commit -m "docs: add quality benchmark and deployment workflow"
```

---

## Final Acceptance Checklist

- [ ] `npm test` passes all unit and Worker integration tests.
- [ ] `npm run typecheck` reports no errors.
- [ ] The ten-case live quality benchmark matches every expected outcome.
- [ ] `/today` returns image bytes and never HTML or JSON.
- [ ] `/today.json` describes the exact served photograph and includes complete attribution.
- [ ] The selected source is natively at least 1920x1080, landscape, and untouched.
- [ ] Only CC BY, CC BY-SA, CC0, and public-domain photos are eligible.
- [ ] A successful preparation creates the next image and fills up to nine reserve slots.
- [ ] Discovery, AI, Flickr, KV, and request-time source failures never lower quality gates.
- [ ] The public service remains inside Cloudflare free-tier assumptions.
