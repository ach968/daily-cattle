# Repository guidance

These instructions apply to the entire repository.

## Project contract

`daily-cattle` is a Cloudflare Worker that serves one verified cattle-in-a-pasture photograph per UTC day. `GET /` and `GET /today` return identical original image bytes, while `GET /today.json` returns attribution and selection metadata.

Keep the service keyless and suitable for Cloudflare's free tier. WordPress Photo Directory is the primary provider and Wikimedia Commons is the fallback. Do not add Flickr or another provider that requires an API key unless the user explicitly changes this requirement.

## Code map

- `src/index.ts`: Worker fetch and scheduled entrypoints.
- `src/http.ts`: public routes, caching, upstream streaming, and request-time fallback.
- `src/wordpress.ts` and `src/commons.ts`: provider discovery and normalization.
- `src/quality.ts`: Workers AI prompt, strict response parsing, and quality scoring.
- `src/selector.ts`, `src/lifecycle.ts`, and `src/state.ts`: selection, UTC promotion, reserves, and KV persistence.
- `scripts/smoke.mjs`: deployed endpoint verification.
- `benchmark/` and `scripts/benchmark-quality.ts`: fixed quality-gate benchmark.

## Development workflow

1. Install locked dependencies with `npm ci`.
2. Use test-driven development for behavior changes: add the regression test, observe the intended failure, then implement the smallest fix.
3. Run `npm test -- --run` and `npm run typecheck` after code changes.
4. Run `npx wrangler deploy --dry-run` for changes that affect the Worker bundle or bindings.
5. Update `scripts/smoke.mjs` and its tests when public endpoint behavior changes.

Keep validation fail-closed. Malformed provider data, unsupported licenses, invalid AI output, and unavailable images must never become public selections.

## Invariants

- Accept only native landscape images at least 1920 pixels wide and 1080 pixels high.
- Stream original provider bytes; do not resize, crop, recompress, transform, or upscale images.
- Accept only CC BY, CC BY-SA, CC0, or Public Domain licensing with canonical attribution metadata.
- Keep the quality threshold at 75/100 and the shared preparation budget at no more than 20 AI evaluations per preparation run.
- Keep provider order deterministic: WordPress first, Commons second.
- Keep preparation scheduled every 12 hours at `11:45` and `23:45` UTC, and promotion daily at `00:00` UTC.
- Keep at most nine verified reserves and retain the last 30 served provider-scoped photo IDs.
- Store metadata and selection state in KV, never image files.
- Keep downloaded or generated image files out of the repository.

Do not loosen these constraints merely to make a test, benchmark, or daily selection pass. Change them only when the user explicitly requests a product-policy change.

## Cloudflare and deployment safety

- Preserve the production `STATE` KV binding and namespace ID in `wrangler.jsonc` unless the user explicitly requests a migration.
- Do not create, replace, delete, or clear Cloudflare resources without explicit authorization.
- Do not deploy production changes unless the user explicitly authorizes deployment.
- After an authorized deployment, run the production smoke check with `SERVICE_URL` set to the exact deployed URL.
- Never commit credentials, API tokens, `.dev.vars`, `.env`, Wrangler state, or provider image files.
