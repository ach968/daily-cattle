# Open Cattle Picture-of-the-Day Service Design

**Date:** 2026-08-26

**Status:** Approved design; awaiting written-spec review

**Working name:** `cattle-pic`

## Purpose

Provide a stable public URL that returns one high-quality photograph of cattle grazing in a pasture for each UTC day. Selection is automatic, the source image is natively at least 1920x1080 and landscape, and the Worker never resizes, crops, recompresses, or upscales it.

Image quality takes priority over novelty. If discovery produces no passing photograph, the service promotes a previously verified reserve or retains the current verified image. It stores provider metadata and selection state, but never stores image bytes in KV or permanent object storage.

This design supersedes the Flickr-keyed design. It removes all paid and keyed image-discovery dependencies.

## Public Contract

### `GET /today`

Returns the current photograph as image bytes.

- The URL remains stable and the selection normally remains unchanged for the UTC day.
- The upstream format, bytes, and aspect ratio are preserved.
- Native width is at least 1920 pixels, native height is at least 1080 pixels, and width exceeds height.
- Headers include the upstream `Content-Type`, `ETag`, CORS, cache lifetime ending at the next UTC midnight, a `describedby` link to `/today.json`, and a canonical link to the provider page.

### `GET /today.json`

Returns:

- UTC selection date
- Provider and provider-specific photo ID
- Title or description
- Creator name and profile URL when supplied
- Provider landing page
- License name and license URL
- Native width and height
- Exact source image URL
- Overall quality score and component scores
- Selection origin: fresh, reserve, or retained

CC0 does not require attribution, but the service preserves and exposes creator and source details whenever available.

## Platform Architecture

The runtime remains entirely on Cloudflare's free-tier components:

- One Cloudflare Worker
- One Workers KV namespace for versioned metadata
- One Workers AI binding using `@cf/meta/llama-3.2-11b-vision-instruct`
- Cron Triggers for preparation at 11:45 and 23:45 UTC and promotion at 00:00 UTC
- The Cache API for successful daily image responses

The existing production KV namespace is retained. No public Worker has been deployed, so the provider-neutral state schema can replace the pre-deployment Flickr schema without migration compatibility.

## Provider Boundary

Discovery and revalidation use a provider-neutral interface. Each provider implementation must support:

- Searching ranked candidates for a bounded query
- Resolving a candidate to authoritative original-image metadata
- Revalidating an existing selection as valid, definitively invalid, or transiently unverifiable
- Returning source, creator, license, dimensions, MIME type, and landing-page metadata

Provider IDs are globally namespaced, such as `wordpress:234123` and `commons:File:Cattle.jpg`. Provider responses are treated as unknown input and validated strictly before entering state.

Transient provider failures preserve previously verified reserves. Definitive removal, disallowed licensing, inadequate dimensions, or unreachable source responses remove the affected entry. Fresh candidates fail closed on either transient or definitive validation failure.

## Primary Provider: WordPress Photo Directory

The WordPress Photo Directory is the primary source because its public REST API is anonymous, its collection is moderated, and all directory photographs are published under CC0.

Discovery uses `https://wordpress.org/photos/wp-json/wp/v2/photos` with:

- Landscape orientation taxonomy
- Embedded creator and featured-media records
- Bounded page sizes and pagination
- Cattle/pasture search phrases and tags
- Relevance and recency passes where the API supports them

Representative queries include:

- `cattle pasture`
- `cows grazing`
- `cow meadow`
- `livestock grassland`
- `bovinae pasture`

The embedded full media record is authoritative for the direct original URL, MIME type, width, and height. The photo record supplies its stable landing page, description, tags, and creator relation.

WordPress candidates must be published photographs from the Photo Directory, use the CC0 policy, expose a reachable original JPEG, satisfy the native dimension and landscape gates, and pass the AI quality gate. Revalidation refetches the photo and media records and confirms they still describe the same published original.

Requests use bounded concurrency, a descriptive User-Agent, caching where appropriate, exponential backoff for rate limiting or server failures, and no scraping of HTML pages.

## Secondary Provider: Wikimedia Commons

Wikimedia Commons is queried only when WordPress discovery cannot prepare the next image and replenish the reserve within the quality and AI-call limits.

Discovery uses the official MediaWiki Action API with file-namespace search and `imageinfo`. It requests:

- Original file URL
- Exact width and height
- MIME and media type
- Creator, credit, description, and source metadata
- Canonical license name and license URL
- Commons file-description page

Only bitmap photographs under CC0, public domain, CC BY, or CC BY-SA are eligible. Noncommercial, no-derivatives, all-rights-reserved, unknown, or ambiguous licenses fail closed. License URL and short-name mappings are allowlisted explicitly rather than accepted through substring matching.

Commons queries use a descriptive User-Agent, serial or tightly bounded requests, `maxlag`, response caching, and retry/backoff behavior required by Wikimedia's API usage guidance. Flickr-origin files already hosted by Commons may be selected, but Commons metadata and the Commons-hosted original are authoritative; the service never depends on Flickr's API or constructs Flickr size URLs.

## Discovery and Selection

Each 11:45 and 23:45 UTC preparation job performs these steps:

1. Read the complete current state.
2. Revalidate existing reserves with their originating providers.
3. Search and hard-filter WordPress candidates.
4. Score eligible WordPress previews until the ready set is full, candidates are exhausted, or the per-run AI budget requires consulting the fallback pool.
5. If one next image plus nine reserves are not available, search, hard-filter, and score Commons candidates with the remaining per-run AI budget.
6. Rank all passing candidates by quality score, then provider search rank, provider priority, and a UTC-date hash used only as a deterministic tie-breaker.
7. Store one prepared next-day image and up to nine ordered reserves as a complete state document.

The service excludes the current image, existing reserves, and the last 30 served provider-prefixed IDs. Search results are deduplicated by provider ID and normalized source URL.

WordPress is preferred before Commons, but neither provider may bypass hard gates or the fixed quality threshold. If the primary provider is unavailable, Commons can still fill the ready set. If both providers fail, existing verified reserves remain intact.

## Hard Candidate Gates

Every fresh candidate must satisfy all of the following before AI evaluation:

- Supported provider and strictly valid response schema
- Allowed license
- Published still photograph
- Reachable direct original image URL
- Native width at least 1920 pixels
- Native height at least 1080 pixels
- Native width greater than native height
- Image MIME type
- Not current, reserved, recently served, or duplicated

The Worker validates returned image response type and availability. It does not infer a larger source URL by rewriting thumbnail paths.

## Visual Quality Gate

Workers AI evaluates a provider preview, not the full original, with the existing fixed prompt, temperature zero, and strict JSON schema.

The rejection policy remains:

- Illustration, painting, diagram, or synthetic-looking image
- Machinery or people dominating the scene
- Cattle too small or distant to be meaningful subjects
- Watermark, border, text overlay, or obvious artifact
- Soft focus, motion blur, severe noise, or visible compression damage
- Severe exposure or color problems
- Weak standalone composition

The 100-point rubric remains:

- 30: sharpness, exposure, and technical quality
- 30: cattle visibility and pasture relevance
- 20: composition
- 15: landscape and atmosphere
- 5: absence of distractions

The threshold is 75. Malformed or uncertain AI output fails closed.

At most 20 previews are evaluated during one preparation run. This bounds Workers AI usage to at most 40 previews per UTC day; it does not limit public image requests, provider searches, or reserve revalidation. Hard gates run first. If all 20 fail, the Worker retains verified state rather than lowering the threshold.

## Daily Lifecycle

### Preparation at 11:45 and 23:45 UTC

- Revalidate reserves across both providers.
- Discover and score fresh candidates in provider order.
- Prepare tomorrow's highest-scoring passing candidate.
- Refill the reserve to at most nine entries.
- Preserve the previous complete state if preparation throws or cannot produce a valid next image.

### Promotion at 00:00 UTC

- Promote the prepared candidate when it remains valid.
- Otherwise promote the highest-scoring valid reserve.
- Otherwise retain yesterday's verified image.
- Add the image that stopped being current to the bounded recent-ID history, not back to the reserve.

Provider type does not affect promotion priority after candidates have passed all gates.

## Request-Time Serving and Fallback

On a `/today` cache miss:

1. Read the complete current state from KV.
2. Fetch the exact validated provider source URL.
3. Retry once for a transient upstream failure.
4. Stream successful bytes untouched and cache them until the next UTC midnight.
5. On persistent source failure, revalidate and conditionally promote a reserve using its originating provider.
6. Return `502` if no checked image can be served.

The request path never performs discovery or invokes Workers AI.

Fallback promotion is serialized within a Worker isolate and conditioned on the failed current ID. Workers KV has no global compare-and-swap, so simultaneous failures in different Cloudflare locations can briefly serve different verified reserves until KV converges. Strict global serialization would require a Durable Object and is outside the approved free KV architecture.

Cache lookup, insertion, and invalidation are best-effort. Cache failures are logged but never prevent serving a verified source.

## State Model

KV stores one versioned document containing:

- Schema version
- Current selection
- Optional prepared next-day selection
- Ordered reserves, maximum nine
- Last 30 served provider-prefixed IDs
- Last preparation and promotion outcomes

Every selection contains:

- Provider and provider ID
- Globally namespaced ID
- Title or description
- Creator and creator profile URL when available
- Provider landing page
- License and license URL
- Exact validated source URL
- Native width, height, and MIME type
- Quality score, components, model, and scoring timestamp
- Intended or served UTC date
- Origin: fresh, reserve, or retained

No authentication material or image bytes enter KV or public metadata.

## Failure Handling

- **Primary discovery failure:** continue with Commons using the remaining daily AI budget.
- **Both providers fail:** keep verified reserves and existing prepared state; do not lower gates.
- **Transient revalidation failure:** preserve the previously verified entry but do not admit an unverified fresh candidate.
- **Definitive invalidation:** remove the entry and continue to the next checked reserve.
- **AI failure or invalid output:** reject the candidate and log without image payloads or secrets.
- **KV propagation delay:** serve the last complete verified state until convergence.
- **No checked request-time fallback:** return a temporary upstream error.

## Observability

Structured logs record:

- Provider, query, page, and candidate counts
- Hard-gate rejection reasons
- AI pass/fail decisions and component scores
- Reserve depth before and after preparation
- Promotion source and provider
- Provider, AI, KV, and cache failures
- Request-time fallback events

Logs never contain photograph bytes, AI image payloads, or authorization material.

## Verification

### Unit and contract tests

- Strict WordPress photo, media, author, and taxonomy parsing
- Strict Commons search, imageinfo, extmetadata, and license parsing
- Provider transient-versus-definitive failure classification
- Original URL, MIME, dimension, landscape, and reachability gates
- Provider-prefixed deduplication and recent-history exclusion
- Primary-to-secondary fallback and shared 20-preview cap
- Quality parsing and threshold boundaries
- Reserve revalidation, promotion, retention, and exception preservation
- UTC transitions, cache lifetime, and request-time fallback concurrency

### Quality benchmark

Replace the Flickr-dependent manifest with ten openly licensed WordPress or Commons previews: five representative passes and five representative rejects. The benchmark continues to use the production prompt and parser and cannot change expected labels, hard gates, or the threshold merely to force a pass.

### Integration and live smoke tests

- Mock both provider APIs and original image hosts in the Worker runtime.
- Confirm `/today` bytes and `/today.json` describe the same provider item.
- Confirm original bytes and MIME type are unchanged.
- Confirm source-native dimensions and allowed license.
- Confirm WordPress-first discovery and Commons fallback.
- Confirm one next image and up to nine reserves.
- Confirm no discovery or AI occurs on ordinary requests.
- After deployment, bootstrap through the scheduled preparation and promotion handlers and run the existing repeated-image/metadata smoke test.

## Free-Tier and Operational Constraints

- No image-provider key, account, card, or paid API is required.
- Provider traffic is limited to scheduled preparation, revalidation, and rare request fallback.
- Workers AI evaluation remains capped at 20 previews per preparation run.
- Provider rate limits and Cloudflare free allocations are treated as external limits and checked before deployment changes.
- The service displays provider and licensing metadata even when attribution is optional.

This version excludes a custom domain, gallery, permanent image storage, multiple themes, user accounts, manual moderation UI, and strict cross-region fallback serialization.

## Success Criteria

The service succeeds when:

- A stable public `/today` URL returns one verified cattle/pasture photograph per UTC day.
- Every newly selected image is an untouched native landscape original of at least 1920x1080.
- Every image is CC0, public domain, CC BY, or CC BY-SA with complete source metadata.
- WordPress is used first and Commons fills gaps without lowering quality.
- Daily selection is automatic with a fixed threshold of 75 and at most 20 AI previews per preparation run.
- The ready set maintains one prepared image and up to nine verified reserves.
- Provider, AI, KV, cache, or source failures never admit an unchecked image.
- The system has no paid runtime or image-provider dependency.
