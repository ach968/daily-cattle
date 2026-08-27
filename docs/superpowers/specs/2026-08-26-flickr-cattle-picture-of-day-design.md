# Flickr Cattle Picture-of-the-Day Service Design

> Superseded by [Open Cattle Picture-of-the-Day Service Design](./2026-08-26-open-cattle-picture-of-day-design.md), which replaces keyed Flickr discovery with WordPress Photo Directory first and Wikimedia Commons fallback.

**Date:** 2026-08-26

**Status:** Approved design; awaiting written-spec review

**Working name:** `cattle-pic`

## Purpose

Provide a stable, publicly accessible URL that returns one high-quality Flickr photograph of cattle in a pasture each UTC day. The photograph is chosen automatically, served at its original aspect ratio, and must have native dimensions of at least 1920x1080. Image quality takes priority over novelty: if no new photograph passes the quality gate, the service uses a previously verified reserve or continues serving yesterday's image.

The service does not maintain a permanent album or copy photographs into durable storage. It stores only Flickr URLs, attribution, quality results, and small amounts of selection state.

## User-Facing Contract

### `GET /today`

Returns the current photograph as image bytes, not HTML or JSON.

- The public URL remains stable.
- The photograph remains the same for the UTC calendar day.
- The response preserves the Flickr original's aspect ratio and does not upscale it.
- The source photograph has native width of at least 1920 pixels and native height of at least 1080 pixels.
- The response includes the upstream `Content-Type`, an `ETag`, CORS access, and cache headers that expire at the next UTC midnight.
- `Link` headers identify `/today.json` as descriptive metadata and the Flickr page as the source.

### `GET /today.json`

Returns:

- UTC selection date
- Flickr photo ID and title
- Photographer name and profile URL
- Flickr photo page
- License name and license URL
- Native width and height
- Original image URL
- Overall quality score and component scores
- Whether the selection came from fresh discovery, the reserve, or the previous day

The metadata endpoint supplies discoverable attribution without modifying the photograph.

## Platform Architecture

The service uses only Cloudflare's free-tier components:

- One Cloudflare Worker for HTTP requests and scheduled selection
- One Workers KV namespace for selection metadata
- One Workers AI binding using `@cf/meta/llama-3.2-11b-vision-instruct`
- Two UTC Cron Triggers for preparation and promotion

The initial address uses a free `workers.dev` hostname, such as:

`https://cattle-pic.<account>.workers.dev/today`

A custom domain can be added later without changing the endpoint contract.

## External Dependencies

### Flickr API

The service uses a free Flickr API key and these official API operations:

- `flickr.photos.search` to discover candidates
- `flickr.photos.getSizes` to obtain the actual available sizes and per-size URLs

The service never constructs large-image URLs by modifying thumbnail URLs. Flickr may use different secrets for different image sizes, so `getSizes` is authoritative.

### Cloudflare Workers AI

The service uses a vision model to assess cattle visibility, pasture relevance, technical quality, and composition. The model receives Flickr previews rather than original full-resolution files. The Meta model license must be accepted once during setup.

## Licensing Policy

Only the following Flickr licenses are eligible:

- CC BY
- CC BY-SA
- CC0
- Public domain

All-rights-reserved, noncommercial, and no-derivatives licenses are excluded. Although an untouched no-derivatives image might be redistributable, exclusion avoids ambiguity and permits future internal image handling without changing the policy.

The source Flickr page, photographer, license name, and license URL are retained for every selected and reserve entry. CC BY and CC BY-SA attribution is available through `/today.json` and discoverable through the image response's `Link` header.

## Discovery Strategy

The preparation job queries multiple all-tag combinations, including:

- `cow` and `pasture`
- `cattle` and `grazing`
- `cows` and `meadow`
- `cattle` and `grass`
- `livestock` and `pasture`

Searches request up to 100 safe still photographs per tag combination and sort. Results from date-posted and interestingness sorts are merged and deduplicated. The first pass covers photographs uploaded within the last 180 days. If that window produces too few viable candidates, the search expands to all dates rather than lowering the quality threshold.

The service excludes:

- The current photograph
- Entries already in the reserve
- The last 30 served Flickr photo IDs
- Candidates that Flickr no longer permits downloading

Flickr does not guarantee materially different results each day. Daily variety comes from merging several queries, excluding recent IDs, and using the UTC date as a deterministic tie-breaker among candidates with equal scores.

## Hard Candidate Gates

Before invoking the vision model, every candidate must satisfy all of the following:

- Eligible license
- Download permitted by Flickr
- Original or largest available source is reachable
- Native width at least 1920 pixels
- Native height at least 1080 pixels
- Landscape orientation, defined as native width greater than native height
- Still photograph rather than video or illustration metadata
- Not current, reserved, or recently served

Candidates that fail a hard gate are discarded and never sent to Workers AI.

## Visual Quality Gate

Workers AI evaluates a Flickr preview with a fixed prompt, temperature set to zero, and structured JSON output.

The photograph must clearly show cattle outdoors in a pasture or a closely related grazing environment. The model rejects:

- Illustrations, paintings, diagrams, or synthetic-looking images
- Farm machinery or people dominating the scene
- Cattle that are too small or distant to be meaningful subjects
- Watermarks, borders, text overlays, or obvious artifacts
- Soft focus, motion blur, severe noise, or visible compression damage
- Severe underexposure, overexposure, or poor color
- Weak compositions that do not function well as a standalone daily photograph

The 100-point rubric is:

- 30 points: sharpness, exposure, and technical quality
- 30 points: cattle visibility and grazing/pasture relevance
- 20 points: composition
- 15 points: landscape and atmosphere
- 5 points: absence of distracting elements

The passing threshold is 82. The highest-scoring passing candidate becomes the prepared daily selection. Only other candidates scoring at least 82 may enter the reserve. Uncertain, incomplete, or malformed model output fails closed.

The preparation job evaluates at most 20 previews per day by default to remain inside the Workers AI free allocation. It applies hard gates first, then evaluates the strongest remaining previews until it has prepared the day and filled available reserve slots or reaches that cap. The cap is configurable but the score threshold is not adaptive. A quota failure cannot lower the threshold.

## Daily Lifecycle

### Preparation at 23:45 UTC

The preparation job:

1. Revalidates existing reserve entries against Flickr availability and licensing.
2. Discovers and hard-filters fresh candidates.
3. Scores candidates through Workers AI.
4. Chooses the highest-scoring passing candidate for the next UTC day.
5. Adds additional passing candidates to empty reserve slots.
6. Writes a complete prepared state for the next day only after selection succeeds.

The ready set contains one prepared daily image plus up to nine reserve images. The reserve is rolling and exists only for failure recovery; it is not consumed as a normal rotation when fresh discovery succeeds.

### Promotion at 00:00 UTC

The promotion job:

1. Promotes the successfully prepared candidate.
2. If no prepared candidate exists, promotes the highest-scoring valid reserve entry.
3. If the reserve is empty or invalid, retains yesterday's verified photograph.
4. Adds the photograph that stopped being current to the bounded recent-ID history, not back to the reserve.

Selection state is written as a complete object so readers never observe a partially updated record. Workers KV is eventually consistent; locations may briefly retain yesterday's image around midnight, normally for less than a minute, before converging.

## Request and Cache Flow

For `/today`, the Worker uses an internal cache key that includes the UTC selection date even though the public URL is stable. This prevents yesterday's bytes from being reused as today's response.

On a cache miss:

1. Read current selection metadata from KV.
2. Fetch the exact Flickr size URL validated during selection.
3. Stream the response without resizing, recompressing, cropping, or changing format.
4. Cache the successful response until the next UTC midnight.

The public response includes:

- Correct image `Content-Type`
- `Cache-Control` with a lifetime ending at UTC midnight
- `ETag`
- `Access-Control-Allow-Origin: *`
- A `Link` to `/today.json` with `rel="describedby"`
- A `Link` to the Flickr page with `rel="canonical"`

Image bytes are never placed in KV or permanent object storage.

## State Model

KV stores a single versioned state document containing:

- Schema version
- Current selection
- Prepared next-day selection, if present
- Ordered reserve entries, maximum nine
- Last 30 served Flickr photo IDs
- Last preparation and promotion outcomes

Each selection or reserve entry contains:

- Flickr photo ID
- Title
- Photographer and profile URL
- Photo page URL
- License and license URL
- Validated source URL
- Native width and height
- Quality score and component scores
- Scoring model and timestamp
- Intended or served UTC date
- Origin: `fresh`, `reserve`, or `retained`

No authentication tokens or API keys appear in KV metadata or responses. Flickr and Cloudflare credentials are Worker secrets or bindings.

## Failure Handling

### Discovery or AI failure

- Do not write incomplete prepared state.
- Do not reduce the quality threshold.
- At promotion, use a valid reserve or retain yesterday's photograph.

### Selected Flickr image fails during a request

- Retry the selected upstream once for transient failure.
- Revalidate the highest-scoring reserve entry.
- If valid, promote it, invalidate the daily cache key, and serve it.
- If no checked image is available, return a temporary upstream error rather than an unchecked or undersized image.

### Invalid AI output

- Reject the candidate.
- Log the parsing or schema error without including secrets.

### KV propagation delay

- Continue serving the last complete verified state.
- Never synthesize a replacement from unverified search results in the request path.

## Observability

Cloudflare logs record:

- Discovery counts by query
- Hard-gate rejection counts and reasons
- AI pass/fail decisions and component scores
- Reserve depth before and after preparation
- Promotion source: fresh, reserve, or retained
- Flickr and Workers AI errors
- On-request fallback events

Logs do not store photograph bytes, secrets, or complete AI image payloads.

## Verification Strategy

### Unit tests with mocked dependencies

- License mapping and rejection
- Native dimension and landscape checks
- Duplicate and recent-ID exclusion
- UTC date transitions and cache lifetime calculation
- Date-seeded tie-breaking
- AI JSON parsing and score threshold enforcement
- Reserve revalidation, filling, promotion, depletion, and stale removal
- Complete-state writes and schema-version handling
- Flickr, AI, and KV failure paths

### Quality benchmark

A small openly licensed benchmark contains representative good and bad cattle photographs. Before deployment, the fixed prompt must consistently:

- Accept sharp, well-composed cattle-in-pasture photographs
- Reject blurred or badly compressed photographs
- Reject illustrations and non-cattle results
- Reject machinery- or people-dominated scenes
- Reject photographs where cattle are insignificant distant details

The benchmark validates the prompt and threshold. It is not used as a permanent serving catalog.

### Integration tests

Run the Worker locally with mocked Flickr image and API responses, Workers AI responses, KV, and cache behavior. Verify:

- `/today` returns image bytes rather than HTML or JSON
- `/today.json` describes the same Flickr photo
- Source dimensions meet the native minimum
- The original format and aspect ratio are preserved
- Repeated requests within one UTC day return the same selection
- A successful preparation produces one next-day image and up to nine reserves
- Promotion uses fresh, reserve, and retained paths correctly
- Upstream image failure cannot produce an unchecked response

### Live smoke test

After deployment:

- Execute one limited discovery run
- Confirm licensing and `getSizes` metadata against Flickr
- Confirm Workers AI structured output
- Confirm image and metadata endpoint agreement
- Confirm response and attribution headers
- Confirm cache expiry targets the next UTC midnight
- Simulate one unavailable Flickr source and verify checked reserve promotion

## Free-Tier and Scope Constraints

The design targets Cloudflare's current free allocations: 100,000 Worker requests per day and 10,000 Workers AI neurons per day. Candidate evaluation is capped, and quality thresholds never adapt downward to save quota.

This first version intentionally excludes:

- A custom domain
- A user interface or gallery
- Permanent image storage
- User-selected themes
- Multiple daily photographs
- Accounts, analytics dashboards, or manual moderation
- Automated social posting

These can be considered later without changing the `/today` and `/today.json` contracts.

## Success Criteria

The service is successful when:

- A stable public `workers.dev/today` URL returns a verified Flickr cattle/pasture photograph every day.
- Every newly selected source is natively at least 1920x1080 and is never upscaled or recompressed.
- Only approved open licenses are served, with complete attribution metadata.
- Daily selection is fully automatic and uses the fixed quality threshold.
- The ready set maintains one daily image plus as many as nine verified reserves.
- Discovery or upstream failures use verified fallbacks without lowering quality.
- The system operates within Cloudflare's free-tier assumptions, with no paid runtime dependency.
