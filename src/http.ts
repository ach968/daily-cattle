import { secondsUntilNextUtcMidnight } from "./day";
import type { OperationalLogger } from "./lifecycle";
import type { SelectionEntry } from "./model";
import type { StateRepository } from "./state";

export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export interface RequestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RequestDeps {
  repository: StateRepository;
  cache: ResponseCache;
  fetcher: typeof fetch;
  promoteFallback(
    failedPhotoId: string,
    nowMs: number,
  ): Promise<SelectionEntry | null>;
  logger: OperationalLogger;
  ctx: RequestExecutionContext;
}

const fallbackFlights = new Map<
  string,
  Promise<SelectionEntry | null>
>();

function promoteFallbackSingleFlight(
  deps: RequestDeps,
  failedPhotoId: string,
  nowMs: number,
): Promise<SelectionEntry | null> {
  const existing = fallbackFlights.get(failedPhotoId);
  if (existing) return existing;

  const promotion = Promise.resolve().then(() =>
    deps.promoteFallback(failedPhotoId, nowMs),
  );
  const flight = promotion.finally(() => {
    if (fallbackFlights.get(failedPhotoId) === flight) {
      fallbackFlights.delete(failedPhotoId);
    }
  });
  fallbackFlights.set(failedPhotoId, flight);
  return flight;
}

function cacheKey(request: Request, current: SelectionEntry): Request {
  const origin = new URL(request.url).origin;
  return new Request(
    `${origin}/_cache/image/${current.intendedDate}/${current.photoId}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown upstream error";
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isImageResponse(response: Response): boolean {
  return (
    response.ok &&
    (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("image/")
  );
}

async function fetchSource(
  fetcher: typeof fetch,
  sourceUrl: string,
  logger: OperationalLogger,
  photoId: string,
  nowMs: number,
): Promise<Response | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetcher(sourceUrl, { redirect: "follow" });
      if (isImageResponse(response)) return response;

      const retry = attempt === 1 && transientStatus(response.status);
      logger.error({
        event: "image_fetch_failed",
        at: new Date(nowMs).toISOString(),
        photoId,
        status: response.status,
        attempt,
        transient: retry,
      });
      if (!retry) return null;
    } catch (error: unknown) {
      logger.error({
        event: "image_fetch_failed",
        at: new Date(nowMs).toISOString(),
        photoId,
        attempt,
        transient: attempt === 1,
        message: errorMessage(error),
      });
      if (attempt === 2) return null;
    }
  }
  return null;
}

function publicImageResponse(
  upstream: Response,
  request: Request,
  current: SelectionEntry,
  nowMs: number,
): Response {
  const headers = new Headers(upstream.headers);
  const origin = new URL(request.url).origin;
  headers.set(
    "cache-control",
    `public, max-age=${secondsUntilNextUtcMidnight(nowMs)}`,
  );
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "link",
    `<${origin}/today.json>; rel="describedby", <${current.pageUrl}>; rel="canonical"`,
  );
  if (!headers.has("etag")) {
    headers.set(
      "etag",
      `"source-${current.photoId}-${current.intendedDate}"`,
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function metadataResponse(current: SelectionEntry, nowMs: number): Response {
  return Response.json(
    {
      date: current.intendedDate,
      photoId: current.photoId,
      provider: current.provider,
      providerId: current.providerId,
      title: current.title,
      ...(current.photographer === undefined
        ? {}
        : { photographer: current.photographer }),
      ...(current.photographerUrl === undefined
        ? {}
        : { photographerUrl: current.photographerUrl }),
      pageUrl: current.pageUrl,
      license: current.license,
      licenseUrl: current.licenseUrl,
      sourceUrl: current.sourceUrl,
      width: current.width,
      height: current.height,
      quality: current.quality,
      origin: current.origin,
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": `public, max-age=${secondsUntilNextUtcMidnight(nowMs)}`,
      },
    },
  );
}

async function serveSelection(
  request: Request,
  deps: RequestDeps,
  current: SelectionEntry,
  nowMs: number,
): Promise<Response | null> {
  const upstream = await fetchSource(
    deps.fetcher,
    current.sourceUrl,
    deps.logger,
    current.photoId,
    nowMs,
  );
  if (!upstream) return null;

  const response = publicImageResponse(upstream, request, current, nowMs);
  deps.ctx.waitUntil(deps.cache.put(cacheKey(request, current), response.clone()));
  return response;
}

export async function handleRequest(
  request: Request,
  deps: RequestDeps,
  nowMs: number,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    (path !== "/" && path !== "/today" && path !== "/today.json")
  ) {
    return new Response("Not found", { status: 404 });
  }

  const state = await deps.repository.read();
  if (!state.current) {
    return new Response("No verified image is available yet", {
      status: 503,
      headers: { "retry-after": "60" },
    });
  }

  if (path === "/today.json") return metadataResponse(state.current, nowMs);

  const originalCacheKey = cacheKey(request, state.current);
  let cached: Response | undefined;
  try {
    cached = await deps.cache.match(originalCacheKey);
  } catch (error: unknown) {
    deps.logger.error({
      event: "image_cache_match_failed",
      at: new Date(nowMs).toISOString(),
      photoId: state.current.photoId,
      message: errorMessage(error),
    });
  }
  if (cached) return cached;

  const currentResponse = await serveSelection(
    request,
    deps,
    state.current,
    nowMs,
  );
  if (currentResponse) return currentResponse;

  let fallback: SelectionEntry | null;
  try {
    fallback = await promoteFallbackSingleFlight(
      deps,
      state.current.photoId,
      nowMs,
    );
  } catch (error: unknown) {
    deps.logger.error({
      event: "fallback_promotion_failed",
      at: new Date(nowMs).toISOString(),
      photoId: state.current.photoId,
      message: errorMessage(error),
    });
    fallback = null;
  }
  if (!fallback) {
    return new Response("No checked upstream image is available", { status: 502 });
  }

  try {
    await deps.cache.delete(originalCacheKey);
  } catch (error: unknown) {
    deps.logger.error({
      event: "image_cache_delete_failed",
      at: new Date(nowMs).toISOString(),
      photoId: state.current.photoId,
      message: errorMessage(error),
    });
  }
  const fallbackResponse = await serveSelection(request, deps, fallback, nowMs);
  if (fallbackResponse) return fallbackResponse;

  return new Response("No checked upstream image is available", { status: 502 });
}
