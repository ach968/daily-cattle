# Keyless Cattle Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace keyed Flickr discovery with anonymous WordPress Photo Directory discovery first and Wikimedia Commons fallback while preserving the verified daily-image contract.

**Architecture:** Introduce strict provider clients behind a shared interface, namespace every photo ID by provider, and route reserve revalidation through a provider registry. The selector spends one shared 20-preview AI budget in provider order; all lifecycle, request serving, KV, and caching guarantees remain provider-neutral.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers KV, Workers AI, WordPress REST API, MediaWiki Action API, Vitest 4.1+, `@cloudflare/vitest-plugin`, Wrangler 4

**Spec:** `docs/superpowers/specs/2026-08-26-open-cattle-picture-of-day-design.md`

## Global Constraints

- WordPress Photo Directory is primary; Wikimedia Commons is queried only when WordPress cannot prepare one next image and fill available reserve slots.
- No image-provider API key, paid image service, HTML scraping, or constructed original-image URL.
- Native source width is at least 1920, native source height is at least 1080, and width is greater than height.
- Stream exact upstream bytes; never resize, crop, recompress, transform, or upscale.
- Allowed licenses are CC BY, CC BY-SA, CC0, and Public Domain only.
- Quality threshold remains exactly 82/100; malformed model output fails closed.
- At most 20 previews are submitted to Workers AI per preparation run across both providers.
- State holds one current, one optional next, at most nine reserves, and the last 30 served globally namespaced IDs.
- Transient revalidation failures preserve verified reserves; definitive invalidation removes them; fresh candidates fail closed on either outcome.
- Request handling never performs discovery or invokes Workers AI.
- External JSON is `unknown` until exact fields and values are validated.
- Workers KV remains the only persistent store and never contains image bytes.
- Existing KV namespace `eb36e91840db454fa0a00d12c098b1d9` remains bound as `STATE`.

## File Map

- `src/model.ts` — provider-neutral public and persisted domain types
- `src/provider.ts` — shared provider interface, transient error, URL checks, and source availability
- `src/wordpress.ts` — strict WordPress Photo Directory search and revalidation
- `src/commons.ts` — strict Wikimedia Commons search, license parsing, and revalidation
- `src/providers.ts` — ordered registry and provider dispatch
- `src/selector.ts` — WordPress-first selection with Commons fallback and one AI budget
- `src/lifecycle.ts` — provider-neutral reserve revalidation and promotion
- `src/state.ts` — schema-version-2 KV parsing
- `src/http.ts` — provider metadata and generic ETags
- `src/index.ts` — concrete keyless provider wiring
- `src/config.ts` — provider queries, API constants, and existing limits
- `test/wordpress.spec.ts` — WordPress contract tests
- `test/commons.spec.ts` — Commons contract tests
- `test/providers.spec.ts` — registry dispatch tests
- Existing test files — provider-neutral regression coverage
- Delete `src/flickr.ts` and `test/flickr.spec.ts` after new wiring passes
- `benchmark/quality-cases.json` — five CC0 pass and five CC0 reject previews
- `README.md` — keyless setup, provider policy, benchmark, and deployment

---

### Task 1: Provider-Neutral Domain and State Schema

**Files:**
- Create: `src/provider.ts`
- Modify: `src/model.ts`
- Modify: `src/config.ts`
- Modify: `src/state.ts`
- Modify: `src/flickr.ts`
- Modify: `src/http.ts`
- Modify: `test/factories.ts`
- Modify: `test/state.spec.ts`
- Modify: `test/http.spec.ts`
- Modify: `test/flickr.spec.ts`

**Interfaces:**
- Produces: `PhotoProviderName`, `RankedCandidate`, `SearchPass`, `PhotoProviderClient`, `ProviderTransientError`, `checkSourceAvailability`
- Produces: `EligiblePhoto.provider`, `EligiblePhoto.providerId`, globally namespaced `EligiblePhoto.photoId`
- Transitional only: `PhotoProviderName` includes `"flickr"` until Task 6 removes the legacy client

- [ ] **Step 1: Write failing provider-domain and state tests**

Add assertions equivalent to:

```ts
expect(eligiblePhoto()).toMatchObject({
  provider: "wordpress",
  providerId: "234123",
  photoId: "wordpress:234123",
});

expect(() =>
  parseServiceState({
    ...serviceState(),
    current: { ...entry(), providerId: "different" },
  }),
).toThrow("selection provider ID does not match its global photo ID");

expect(metadata.photoId).toBe("wordpress:234123");
expect(metadata.provider).toBe("wordpress");
expect(metadata.providerId).toBe("234123");
```

Test schema version `2`, optional creator fields, exact provider allowlisting, and a generic ETag prefix rather than `flickr-`.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
npm test -- test/state.spec.ts test/http.spec.ts test/flickr.spec.ts
```

Expected: failures for missing provider fields, schema version `1`, and Flickr-specific ETag output.

- [ ] **Step 3: Add the shared provider contract**

Create `src/provider.ts` with these public shapes:

```ts
import type { EligiblePhoto, PhotoProviderName } from "./model";

export type SearchPass = "recent" | "all";

export interface RankedCandidate {
  photo: EligiblePhoto;
  searchRank: number;
}

export interface PhotoProviderClient {
  readonly provider: PhotoProviderName;
  search(nowMs: number, pass: SearchPass): Promise<RankedCandidate[]>;
  isAvailable(photo: EligiblePhoto): Promise<boolean>;
  isEligible(photo: EligiblePhoto): Promise<boolean>;
}

export class ProviderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransientError";
  }
}

export function globalPhotoId(
  provider: PhotoProviderName,
  providerId: string,
): string {
  return `${provider}:${providerId}`;
}

export async function checkSourceAvailability(
  fetcher: typeof fetch,
  photo: EligiblePhoto,
): Promise<boolean>;
```

`checkSourceAvailability` performs HEAD, falls back to a range GET for 405/501, requires an image content type, returns `false` for definitive non-image/404/410 responses, and throws `ProviderTransientError` for fetch rejection, 408, 425, 429, or 5xx.

- [ ] **Step 4: Migrate the domain and strict KV schema**

Change the relevant domain fields to:

```ts
export type PhotoProviderName = "wordpress" | "commons" | "flickr";

export interface EligiblePhoto {
  provider: PhotoProviderName;
  providerId: string;
  photoId: string;
  title: string;
  photographer?: string;
  photographerUrl?: string;
  pageUrl: string;
  license: AllowedLicense;
  licenseUrl: string;
  sourceUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface ServiceState {
  schemaVersion: 2;
  // existing fields unchanged
}
```

Add all shared provider constants to `src/config.ts` in this task so Tasks 2 and 3 remain disjoint:

```ts
export const WORDPRESS_ENDPOINT =
  "https://wordpress.org/photos/wp-json/wp/v2/photos";
export const WORDPRESS_LANDSCAPE_ORIENTATION_ID = 23;
export const COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
export const OUTBOUND_USER_AGENT =
  "cattle-pic/1.0 (daily open cattle photo service; metadata at /today.json)";
export const PROVIDER_SEARCH_TERMS = [
  "cattle pasture",
  "cows grazing",
  "cow meadow",
  "livestock grassland",
  "bovinae pasture",
] as const;
```

Set `STATE_KEY` to `service-state:v2`. Update `ENTRY_FIELDS` and validation so `providerId` is nonempty, `photoId === globalPhotoId(provider, providerId)`, optional creator fields are either absent or nonempty HTTP/name strings, and unknown fields still fail closed.

Update the temporary Flickr client to emit `provider: "flickr"`, `providerId: photo.id`, and `photoId: globalPhotoId("flickr", photo.id)`. Keep its API lookup keyed by `providerId`.

- [ ] **Step 5: Make HTTP output provider-neutral**

Add `provider` and `providerId` to `/today.json`. Change deterministic fallback ETags to:

```ts
headers.set("etag", `"source-${current.photoId}-${current.intendedDate}"`);
```

Omit `photographer` and `photographerUrl` from JSON only when absent; retain canonical provider-page links.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm test
npm run typecheck
git diff --check
git add -f src/provider.ts src/model.ts src/config.ts src/state.ts src/flickr.ts src/http.ts test/factories.ts test/state.spec.ts test/http.spec.ts test/flickr.spec.ts
git commit -m "refactor: make daily photo state provider neutral"
```

Expected: full suite and typecheck pass with the temporary Flickr adapter still present.

---

### Task 2: WordPress Photo Directory Provider

**Files:**
- Create: `src/wordpress.ts`
- Create: `test/wordpress.spec.ts`

**Interfaces:**
- Consumes: `PhotoProviderClient`, `RankedCandidate`, `SearchPass`, `checkSourceAvailability`
- Produces: `WordPressPhotoClient implements PhotoProviderClient`, constructed with `fetcher` and `OperationalLogger`

- [ ] **Step 1: Write strict response and request-construction tests**

Use real `Response` objects and fixtures shaped like the public API:

```ts
const photo = {
  id: 234123,
  status: "publish",
  type: "photo",
  link: "https://wordpress.org/photos/photo/296a697b04/",
  content: { rendered: "<p>Cattle grazing on a grassy pasture.</p>" },
  "photo-orientations": [23],
  _embedded: {
    author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
    "wp:featuredmedia": [{
      id: 234124,
      media_type: "image",
      mime_type: "image/jpeg",
      source_url: "https://pd.w.org/2026/07/example.jpg",
      media_details: {
        width: 2800,
        height: 2100,
        sizes: { large: { source_url: "https://pd.w.org/2026/07/example-1024x768.jpg" } },
      },
    }],
  },
};
```

Assert exact search parameters: `_embed=1`, `photo-orientations=23`, `per_page=20`, `search`, `orderby`, `order=desc`, and page. Assert five configured phrases, deduplication, stable search rank, CC0 metadata, full source URL, preview URL, creator fields, HTML-to-text description, and global ID.

Capture the injected logger and assert one `provider_search` event per query with no raw response body or image data.

Reject non-published records, portrait/square taxonomy, missing embedded media, non-image media, non-JPEG MIME, malformed required nested fields, width below 1920, height below 1080, portrait originals, non-HTTPS URLs, and mismatched record/media IDs.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
npm test -- test/wordpress.spec.ts
```

Expected: module resolution failure for `src/wordpress.ts`.

- [ ] **Step 3: Implement search and normalization**

Consume the WordPress endpoint, orientation, terms, and User-Agent constants created by Task 1. Implement `WordPressPhotoClient` with `readonly provider = "wordpress"`. For `recent`, request `orderby=date`; for `all`, request `orderby=relevance`. Run query requests with bounded concurrency, merge successes, and throw `ProviderTransientError` only when every query fails transiently.

After each query, log one structured `provider_search` event containing provider, query, pass, returned count, eligible count, and rejection counts grouped as schema, media, dimensions, and URL. Never log response bodies or image bytes.

Normalize each accepted record directly to a `RankedCandidate`. Use canonical CC0 metadata:

```ts
license: "CC0",
licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
provider: "wordpress",
providerId: String(record.id),
photoId: globalPhotoId("wordpress", String(record.id)),
```

The full embedded media `source_url` is authoritative. Never derive it from a thumbnail filename.

- [ ] **Step 4: Implement availability and live eligibility**

Delegate `isAvailable` to `checkSourceAvailability`. `isEligible` refetches `photos/{providerId}?_embed=1`, parses through the same strict normalizer, and returns `true` only when provider ID, landing page, source URL, dimensions, MIME, and CC0 mapping match the stored photo. Return `false` for 404/410 or definitive mismatch; throw `ProviderTransientError` for network, rate-limit, 5xx, or malformed/indeterminate API responses.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/wordpress.spec.ts
npm test
npm run typecheck
git diff --check
git add -f src/wordpress.ts test/wordpress.spec.ts
git commit -m "feat: add keyless WordPress photo provider"
```

---

### Task 3: Wikimedia Commons Provider

**Files:**
- Create: `src/commons.ts`
- Create: `test/commons.spec.ts`

**Interfaces:**
- Consumes: `PhotoProviderClient`, `RankedCandidate`, `SearchPass`, `checkSourceAvailability`
- Produces: `CommonsPhotoClient implements PhotoProviderClient`, constructed with `fetcher` and `OperationalLogger`

- [ ] **Step 1: Write strict search, license, and request tests**

Use a response fixture with `query.pages[]`, `pageid`, `title`, `canonicalurl`, and one `imageinfo` record containing `url`, `thumburl`, `width`, `height`, `mime`, `mediatype`, and `extmetadata` values.

Assert these request parameters:

```text
action=query
generator=search
gsrnamespace=6
gsrsearch=filetype:bitmap cattle pasture
gsrlimit=20
prop=info|imageinfo
inprop=url
iiprop=url|size|mime|mediatype|extmetadata
iiurlwidth=1024
format=json
formatversion=2
maxlag=5
```

Assert the descriptive User-Agent and `Api-User-Agent`. Test exact mappings for CC0 1.0, Public Domain Mark 1.0, CC BY 2.0/3.0/4.0, and CC BY-SA 2.0/3.0/4.0.

Capture the injected logger and assert provider/query/pass/count fields and grouped rejection counts without extmetadata bodies or image data.

Reject BY-NC, BY-ND, BY-NC-SA, unknown license names, conflicting license name/URL, SVG, non-bitmap media, non-image MIME, missing canonical page, invalid URLs, missing dimensions, undersized or portrait files, and malformed extmetadata.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
npm test -- test/commons.spec.ts
```

Expected: module resolution failure for `src/commons.ts`.

- [ ] **Step 3: Implement exact Commons normalization**

Consume the Commons endpoint, provider terms, and User-Agent constants created by Task 1. For `recent`, set `gsrsort=create_timestamp_desc`; for `all`, use relevance. Preserve the API result order as `searchRank` and deduplicate by page ID.

Log the same `provider_search` event shape used by WordPress, including provider, query, pass, returned/eligible counts, and schema/license/media/dimension/URL rejection counts.

Allow licenses only through a table keyed by normalized canonical license URL and checked against an exact short-name set. Strip HTML from creator and description metadata without evaluating it. When Commons supplies no creator URL, omit `photographerUrl`; never invent a profile URL.

Use page ID for `providerId`, `commons:${pageid}` for the global ID, `imageinfo.url` for the source, `imageinfo.thumburl` for the preview, and `canonicalurl` for the page.

- [ ] **Step 4: Implement revalidation and transient behavior**

Refetch by `pageids={providerId}` with the same `info|imageinfo` properties. Return `false` for a missing page, deleted file, changed source, changed/disallowed license, dimension regression, or media-type regression. Throw `ProviderTransientError` for `maxlag`, API error envelopes that are not definitive missing-file results, fetch rejection, 408/425/429/5xx, or malformed JSON.

Delegate source availability to `checkSourceAvailability`.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/commons.spec.ts
npm test
npm run typecheck
git diff --check
git add -f src/commons.ts test/commons.spec.ts
git commit -m "feat: add Wikimedia Commons fallback provider"
```

Tasks 2 and 3 touch disjoint provider files after Task 1 and may be implemented in parallel worktrees. Integrate both only after their independent reviews pass.

---

### Task 4: Ordered Provider Registry

**Files:**
- Create: `src/providers.ts`
- Create: `test/providers.spec.ts`

**Interfaces:**
- Consumes: ordered `PhotoProviderClient[]`
- Produces: `ProviderRegistry.providers`, `ProviderRegistry.isAvailable`, `ProviderRegistry.isEligible`

- [ ] **Step 1: Write dispatch and invariant tests**

```ts
const registry = new ProviderRegistry([wordpress, commons]);
expect(registry.providers.map((provider) => provider.provider)).toEqual([
  "wordpress",
  "commons",
]);
await registry.isEligible(eligiblePhoto({ provider: "commons", providerId: "42", photoId: "commons:42" }));
expect(commons.isEligible).toHaveBeenCalledOnce();
expect(wordpress.isEligible).not.toHaveBeenCalled();
```

Assert constructor rejection for duplicate provider names, missing WordPress primary, Commons before WordPress, and the transitional Flickr provider. Assert fail-closed rejection when a photo's global ID prefix does not match its provider.

- [ ] **Step 2: Run and confirm failure**

```bash
npm test -- test/providers.spec.ts
```

- [ ] **Step 3: Implement the registry**

```ts
export class ProviderRegistry {
  readonly providers: readonly PhotoProviderClient[];

  constructor(providers: readonly PhotoProviderClient[]) {
    // require exactly [wordpress, commons]
  }

  isAvailable(photo: EligiblePhoto): Promise<boolean> {
    return this.clientFor(photo).isAvailable(photo);
  }

  isEligible(photo: EligiblePhoto): Promise<boolean> {
    return this.clientFor(photo).isEligible(photo);
  }
}
```

Unknown, legacy, or mismatched providers fail closed without making an outbound request.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/providers.spec.ts
npm test
npm run typecheck
git diff --check
git add -f src/providers.ts test/providers.spec.ts
git commit -m "feat: add ordered photo provider registry"
```

---

### Task 5: Multi-Provider Selection and Lifecycle

**Files:**
- Modify: `src/selector.ts`
- Modify: `src/lifecycle.ts`
- Modify: `src/index.ts`
- Modify: `test/selector.spec.ts`
- Modify: `test/lifecycle.spec.ts`
- Modify: `test/worker.spec.ts`

**Interfaces:**
- Consumes: `ProviderRegistry`, `WordPressPhotoClient`, `CommonsPhotoClient`, `QualityScorer`
- Produces: provider-neutral `SelectionEngine` and `LifecycleDeps.providers`

- [ ] **Step 1: Write WordPress-first and shared-budget tests**

Add tests proving:

```ts
expect(wordpress.search).toHaveBeenCalledBefore(commons.search);
expect(commons.search).not.toHaveBeenCalled(); // WordPress filled next + missing reserves
expect(scorer.score).toHaveBeenCalledTimes(10);
```

Also test:

- Commons runs when WordPress supplies too few passing candidates.
- The combined score count never exceeds 20.
- WordPress transient search failure continues to Commons.
- One provider's duplicate global ID is evaluated once.
- Provider-local IDs that happen to match do not collide.
- Existing reserves reduce the number of new passers required.
- Recent IDs exclude both provider types.
- Equal quality uses search rank, provider priority, UTC hash, then global ID.
- Reserve revalidation dispatches to the entry's provider.
- Transient revalidation preserves an entry; definitive failure removes it.
- Every AI decision log contains provider, global photo ID, total, components, hard rejects, and pass/fail without preview bytes.

- [ ] **Step 2: Run focused tests and confirm failures**

```bash
npm test -- test/selector.spec.ts test/lifecycle.spec.ts test/worker.spec.ts
```

Expected: constructor and dependency mismatches referencing `flickr`.

- [ ] **Step 3: Refactor selector to the registry**

Change the constructor to:

```ts
export class SelectionEngine {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly scorer: Pick<QualityScorer, "score">,
    private readonly logger: OperationalLogger,
  ) {}
}
```

Revalidate stored reserves through `providers.isAvailable` and `providers.isEligible`. Calculate the required fresh passers as one next image plus unfilled reserve slots. Iterate `providers.providers` in order, trying `recent` then `all` for each provider, while sharing one `evaluationCount` and one excluded-ID set.

Keep scored search metadata outside persisted state:

```ts
interface ScoredCandidate {
  entry: SelectionEntry;
  searchRank: number;
  providerPriority: number;
}
```

Sort new passers by total descending, search rank ascending, provider priority ascending, UTC hash ascending, then global ID. Existing verified reserves retain their quality ordering.

Emit `quality_decision` after every non-null assessment and `quality_invalid` when scoring fails closed. Include provider, global ID, component scores, total, pass/fail, and hard rejects; exclude preview data and source bytes.

- [ ] **Step 4: Make lifecycle dependencies provider-neutral**

Replace `LifecycleDeps.flickr` with `LifecycleDeps.providers: Pick<ProviderRegistry, "isAvailable" | "isEligible">`. Preserve all existing transient/definitive handling, conditional promotion, single-flight behavior, recent history, and structured event names.

- [ ] **Step 5: Wire concrete providers**

In `src/index.ts`, construct:

```ts
const wordpress = new WordPressPhotoClient(fetch, consoleLogger);
const commons = new CommonsPhotoClient(fetch, consoleLogger);
const providers = new ProviderRegistry([wordpress, commons]);
const selector = new SelectionEngine(providers, scorer, consoleLogger);
```

The fetch path constructs only the repository and provider registry needed for request-time fallback. The scheduled path additionally constructs `QualityScorer` and `SelectionEngine`. No image-provider secret is read.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- test/selector.spec.ts test/lifecycle.spec.ts test/worker.spec.ts
npm test
npm run typecheck
git diff --check
git add -f src/selector.ts src/lifecycle.ts src/index.ts test/selector.spec.ts test/lifecycle.spec.ts test/worker.spec.ts
git commit -m "feat: select daily images from keyless providers"
```

---

### Task 6: Remove Flickr and Finalize Provider-Neutral Contracts

**Files:**
- Delete: `src/flickr.ts`
- Delete: `test/flickr.spec.ts`
- Modify: `src/model.ts`
- Modify: `src/config.ts`
- Modify: `src/state.ts`
- Modify: `test/factories.ts`
- Modify: `test/state.spec.ts`
- Modify: `test/http.spec.ts`

**Interfaces:**
- Produces final `PhotoProviderName = "wordpress" | "commons"`
- Removes `AppEnv.FLICKR_API_KEY`, Flickr query constants, and all Flickr imports

- [ ] **Step 1: Write final-contract tests**

Assert that persisted `provider: "flickr"` fails schema parsing, `AppEnv` type checks without `FLICKR_API_KEY`, metadata contains provider information for both allowed providers, and a repository search contains no production Flickr dependency:

```bash
rg -n "FLICKR_API_KEY|FlickrClient|from \"./flickr\"|live.staticflickr" src test README.md wrangler.jsonc
```

Expected after implementation: no matches.

- [ ] **Step 2: Remove transitional support**

Narrow the union:

```ts
export type PhotoProviderName = "wordpress" | "commons";

export interface AppEnv {
  STATE: KVNamespace;
  AI: Ai;
}
```

Delete the Flickr module and tests. Remove `RECENT_WINDOW_DAYS`, `TAG_PAIRS`, and Flickr-only imports. Keep `PROVIDER_SEARCH_TERMS` and all daily limits.

- [ ] **Step 3: Verify and commit**

```bash
npm test
npm run typecheck
git diff --check
test -z "$(rg -n 'FLICKR_API_KEY|FlickrClient|from "./flickr"|live.staticflickr' src test README.md wrangler.jsonc || true)"
git add -f src/model.ts src/config.ts src/state.ts test/factories.ts test/state.spec.ts test/http.spec.ts
git add -u src/flickr.ts test/flickr.spec.ts
git commit -m "refactor: remove keyed Flickr discovery"
```

---

### Task 7: Keyless Quality Benchmark and Operator Documentation

**Files:**
- Modify: `benchmark/quality-cases.json`
- Modify: `test/benchmark-quality.spec.ts`
- Modify: `README.md`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Keeps: `npm run benchmark`, `npm run smoke`, `npm run deploy`
- Removes: Flickr key setup
- Documents: anonymous provider behavior and existing production KV binding

- [ ] **Step 1: Replace the benchmark manifest with fixed CC0 previews**

Use exactly these five expected passes:

```json
[
  { "id": "wordpress:234123", "url": "https://pd.w.org/2026/07/296a697b0475c861.68075092-1024x768.jpg", "expected": "pass" },
  { "id": "wordpress:220305", "url": "https://pd.w.org/2026/06/6076a246b8ddf3fd3.71611506-1024x683.jpg", "expected": "pass" },
  { "id": "wordpress:198387", "url": "https://pd.w.org/2026/04/37769e3e37fd43491.19488756-1024x576.jpg", "expected": "pass" },
  { "id": "wordpress:196511", "url": "https://pd.w.org/2026/04/69469e1010661fbd8.73614172-1024x768.jpeg", "expected": "pass" },
  { "id": "wordpress:127290", "url": "https://pd.w.org/2025/04/233680fce5a0a1ad1.29801946-1024x768.jpg", "expected": "pass" }
]
```

Append exactly these five expected rejects:

```json
[
  { "id": "wordpress:229505", "url": "https://pd.w.org/2026/07/1596a528beb5c6349.63443660-1024x576.jpg", "expected": "reject" },
  { "id": "wordpress:197224", "url": "https://pd.w.org/2026/04/65269e1cf90255cf9.45959761-1024x576.jpg", "expected": "reject" },
  { "id": "wordpress:191930", "url": "https://pd.w.org/2026/04/83269d4a5f89658b2.80974906-1024x575.jpg", "expected": "reject" },
  { "id": "wordpress:188739", "url": "https://pd.w.org/2026/03/76069c4c06a96b5b4.65686304-1024x737.jpg", "expected": "reject" },
  { "id": "wordpress:184877", "url": "https://pd.w.org/2026/02/8656991addf801346.08343302-1024x965.jpeg", "expected": "reject" }
]
```

The negative cases cover vehicle dominance, cattle as insignificant distant details, cowrie jewelry, cowboy-hat lexical noise, and a decorative brass cow.

- [ ] **Step 2: Update benchmark manifest tests**

Assert ten unique `wordpress:` IDs, five pass/five reject labels, only `https://pd.w.org/` URLs, and no Flickr hostname. Retain API-token redaction tests.

- [ ] **Step 3: Rewrite setup and operations documentation**

README must state:

- WordPress Photo Directory primary and Commons fallback
- No image-provider key, account, card, or secret
- Allowed license and native-dimension policy
- Existing KV namespace is already configured
- Wrangler login, tests, typecheck, benchmark credentials, deploy, scheduled bootstrap, and smoke commands
- Descriptive provider User-Agent, retries, and low daily traffic
- Cron propagation and KV consistency caveats
- API token is needed only for the optional direct REST benchmark, not provider discovery or deployed Worker image selection

Remove every Flickr setup instruction and claim.

- [ ] **Step 4: Verify configuration and commit**

Keep the existing `STATE` ID and AI binding. Run:

```bash
npm test -- test/benchmark-quality.spec.ts
npm test
npm run typecheck
npx wrangler deploy --dry-run
git diff --check
test -z "$(rg -n 'FLICKR_API_KEY|Flickr API key|live.staticflickr' README.md benchmark wrangler.jsonc || true)"
git add -f benchmark/quality-cases.json test/benchmark-quality.spec.ts README.md wrangler.jsonc
git commit -m "docs: document keyless provider deployment"
```

---

### Task 8: Complete Verification, Deployment, and Bootstrap

**Files:**
- Modify only if verification exposes a defect in an earlier task

**Interfaces:**
- Consumes: associated Wrangler OAuth account, existing KV binding, optional `CLOUDFLARE_ACCOUNT_ID` and scoped `CLOUDFLARE_API_TOKEN` for direct benchmark
- Produces: deployed `workers.dev` URL and initialized production state

- [ ] **Step 1: Run the full local verification suite**

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, dry-run lists the existing `STATE` and `AI` bindings, and the worktree is clean.

- [ ] **Step 2: Run the live ten-case quality benchmark when scoped REST credentials are available**

```bash
export CLOUDFLARE_ACCOUNT_ID="ddc108be72a240ac581eb9e1291b82c5"
read -rs CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
npm run benchmark
```

Expected: ten `MATCH` lines and exit status zero. If a visually confirmed positive or negative does not match, change only `QUALITY_PROMPT`, rerun `test/quality.spec.ts`, and rerun all ten cases. Never change the threshold, hard gates, or expected labels merely to force a pass. Do not commit or print the token.

- [ ] **Step 3: Deploy with the associated Wrangler account**

```bash
npm run deploy
```

Record the exact `workers.dev` URL printed by Wrangler. Confirm deployment output lists Cron triggers `45 23 * * *` and `0 0 * * *`, KV binding `STATE`, and AI binding `AI`.

- [ ] **Step 4: Bootstrap production state through scheduled handlers**

```bash
npx wrangler dev --remote --test-scheduled
```

In a second terminal, invoke:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=45+23+*+*+*&time=1787787900000&format=json"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+0+*+*+*&time=1787788800000&format=json"
```

Expected: both report `"outcome":"ok"`. Stop remote development immediately. If Workers AI reports a model-agreement requirement, complete the official Cloudflare agreement once and repeat preparation; do not bypass AI scoring.

- [ ] **Step 5: Run deployed smoke verification**

```bash
read -r SERVICE_URL
export SERVICE_URL
npm run smoke
```

Expected: `/today` succeeds twice with byte-identical image bodies; `/today.json` describes the same provider item; width/height, image MIME, ETag, cache, CORS, canonical, and descriptive links pass.

- [ ] **Step 6: Inspect production metadata without mutating state**

Verify `/today.json` contains `provider` equal to `wordpress` or `commons`, a matching provider-prefixed `photoId`, allowed license metadata, native dimensions, and no secret fields. Verify the source and canonical URLs use the selected provider's hosts.

- [ ] **Step 7: Commit only verification-driven fixes**

If no defect was found, create no commit. If a defect was fixed, rerun Steps 1 and 5, stage only the exact affected files, and use a narrow commit message describing the verified defect.

---

## Final Acceptance Checklist

- [ ] Full unit and Cloudflare-runtime suite passes.
- [ ] Strict TypeScript check passes.
- [ ] Production bundle dry-run passes with KV and AI bindings.
- [ ] Production source contains no Flickr API dependency or image-provider secret.
- [ ] WordPress is queried before Commons.
- [ ] A shared maximum of 20 previews is enforced.
- [ ] Only native landscape originals at least 1920x1080 enter state.
- [ ] Only CC0, Public Domain, CC BY, and CC BY-SA enter state.
- [ ] `/today` streams untouched image bytes.
- [ ] `/today.json` identifies the same provider item and complete license/source metadata.
- [ ] One next selection and at most nine reserves are maintained.
- [ ] Transient provider failures preserve verified state; definitive failures remove stale entries.
- [ ] Live benchmark matches all ten fixed cases when benchmark credentials are available.
- [ ] Scheduled preparation and promotion initialize production KV.
- [ ] Deployed smoke test passes at the exact Wrangler URL.
