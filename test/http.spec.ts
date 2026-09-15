import { describe, expect, it, vi } from "vitest";

import { OUTBOUND_USER_AGENT } from "../src/config";
import { handleRequest, type RequestDeps } from "../src/http";
import { promoteAvailableReserveIfCurrent } from "../src/lifecycle";
import type { SelectionEntry, ServiceState } from "../src/model";
import type { StateRepository } from "../src/state";
import { entry, serviceState } from "./factories";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

class MemoryRepository {
  readonly writeCalls: ServiceState[] = [];

  constructor(private state: ServiceState) {}

  async read(): Promise<ServiceState> {
    return structuredClone(this.state);
  }

  async write(state: ServiceState): Promise<void> {
    this.writeCalls.push(structuredClone(state));
    this.state = structuredClone(state);
  }
}

class PairedInitialReadRepository extends MemoryRepository {
  private initialReads = 0;
  private releaseInitialReads!: () => void;
  private readonly bothInitialReadsStarted = new Promise<void>((resolve) => {
    this.releaseInitialReads = resolve;
  });

  override async read(): Promise<ServiceState> {
    const snapshot = await super.read();
    this.initialReads += 1;
    if (this.initialReads <= 2) {
      if (this.initialReads === 2) this.releaseInitialReads();
      await this.bothInitialReadsStarted;
    }
    return snapshot;
  }
}

class MemoryCache {
  readonly matches: string[] = [];
  readonly puts: Array<{ key: string; response: Response }> = [];
  readonly deletes: string[] = [];
  stored?: Response;

  async match(request: Request): Promise<Response | undefined> {
    this.matches.push(request.url);
    return this.stored?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts.push({ key: request.url, response: response.clone() });
  }

  async delete(request: Request): Promise<boolean> {
    this.deletes.push(request.url);
    return true;
  }
}

function deps(options: {
  current?: SelectionEntry;
  state?: Partial<ServiceState>;
  cache?: MemoryCache;
  fetcher?: typeof fetch;
  promoteFallback?: (
    failedPhotoId: string,
    nowMs: number,
  ) => Promise<SelectionEntry | null>;
} = {}): RequestDeps & { cache: MemoryCache; pending: Promise<unknown>[] } {
  const cache = options.cache ?? new MemoryCache();
  const pending: Promise<unknown>[] = [];
  return {
    repository: new MemoryRepository(
      serviceState({
        ...options.state,
        ...(options.current === undefined ? {} : { current: options.current }),
      }),
    ) as unknown as StateRepository,
    cache,
    fetcher:
      options.fetcher ??
      (vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch),
    promoteFallback: options.promoteFallback ?? (async () => null),
    logger: { info: vi.fn(), error: vi.fn() },
    ctx: {
      waitUntil(promise: Promise<unknown>): void {
        pending.push(promise);
      },
    },
    pending,
  };
}

describe("handleRequest routes", () => {
  it.each([
    ["WordPress", "wordpress", "234123"],
    ["Wikimedia Commons", "commons", "File:Cattle in pasture.jpg"],
  ] as const)("returns metadata matching the current %s image", async (_name, provider, providerId) => {
    const current = entry({ provider, providerId });
    const response = await handleRequest(
      new Request("https://service/today.json"),
      deps({
        current,
        state: {
          lastPromotion: {
            at: "2026-08-26T12:00:00.000Z",
            status: "success",
            detail: "promoted fresh",
          },
        },
      }),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      date: "2026-08-26",
      slot: "2026-08-26T12:00:00.000Z",
      photoId: `${provider}:${providerId}`,
      provider,
      providerId,
      title: "Cattle in a pasture",
      photographer: "Ada Lovelace",
      photographerUrl: "https://example.com/photographers/ada",
      pageUrl: "https://example.com/photos/photo-1",
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      sourceUrl: "https://example.com/photos/photo-1/source.jpg",
      displayUrl: "https://example.com/photos/photo-1/preview.jpg",
      width: 4032,
      height: 3024,
      quality: { total: 90, technical: 27, subject: 28 },
      origin: "fresh",
    });
  });

  it("returns 404 for unknown routes and 503 before bootstrap", async () => {
    expect(
      (await handleRequest(new Request("https://service/nope"), deps(), NOW)).status,
    ).toBe(404);
    expect(
      (await handleRequest(new Request("https://service/full"), deps(), NOW)).status,
    ).toBe(503);
    expect(
      (await handleRequest(new Request("https://service/today.json"), deps(), NOW)).status,
    ).toBe(503);
  });
});

describe("handleRequest image streaming", () => {
  it("serves preview aliases and full resolution with isolated caches and ETags", async () => {
    const current = entry();
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      new Response(String(input) === current.previewUrl ? "preview bytes" : "original bytes", {
        headers: { "content-type": "image/jpeg" },
      }),
    ) as unknown as typeof fetch;
    const requestDeps = deps({ current, fetcher });
    const cached = new Map<string, Response>();
    requestDeps.cache.match = async (request) => cached.get(request.url)?.clone();
    requestDeps.cache.put = async (request, response) => {
      cached.set(request.url, response.clone());
    };

    const root = await handleRequest(new Request("https://service/"), requestDeps, NOW);
    await Promise.all(requestDeps.pending);
    const full = await handleRequest(new Request("https://service/full"), requestDeps, NOW);
    await Promise.all(requestDeps.pending);
    const today = await handleRequest(new Request("https://service/today"), requestDeps, NOW);
    const fullAgain = await handleRequest(new Request("https://service/full"), requestDeps, NOW);

    expect(new Uint8Array(await root.arrayBuffer())).toEqual(new TextEncoder().encode("preview bytes"));
    expect(new Uint8Array(await today.arrayBuffer())).toEqual(new TextEncoder().encode("preview bytes"));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(new TextEncoder().encode("original bytes"));
    expect(new Uint8Array(await fullAgain.arrayBuffer())).toEqual(new TextEncoder().encode("original bytes"));
    expect(root.headers.get("etag")).not.toBe(full.headers.get("etag"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(current.previewUrl, expect.objectContaining({
      headers: { "User-Agent": OUTBOUND_USER_AGENT },
    }));
    expect(fetcher).toHaveBeenCalledWith(current.sourceUrl, expect.any(Object));
  });

  it("streams untouched bytes and publishes attribution and UTC cache headers", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetcher = vi.fn(async () =>
      new Response(bytes, {
        headers: { "content-type": "image/jpeg", etag: '"upstream-etag"' },
      }),
    ) as unknown as typeof fetch;
    const requestDeps = deps({ current: entry(), fetcher });

    const response = await handleRequest(
      new Request("https://service/full"),
      requestDeps,
      NOW,
    );
    await Promise.all(requestDeps.pending);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("etag")).toBe('"upstream-etag"');
    expect(response.headers.get("cache-control")).toBe("public, max-age=43200");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("link")).toBe(
      '<https://service/today.json>; rel="describedby", <https://example.com/photos/photo-1>; rel="canonical"',
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/photos/photo-1/source.jpg",
      expect.objectContaining({
        redirect: "follow",
        headers: { "User-Agent": OUTBOUND_USER_AGENT },
      }),
    );
    expect(requestDeps.cache.matches).toEqual([
      "https://service/_cache/image/full/2026-08-26/wordpress:234123",
    ]);
    expect(requestDeps.cache.puts[0]?.key).toBe(
      "https://service/_cache/image/full/2026-08-26/wordpress:234123",
    );
  });

  it("uses a deterministic fallback ETag and serves a daily cache hit", async () => {
    const cache = new MemoryCache();
    cache.stored = new Response(new Uint8Array([1, 2, 3]), {
      headers: { etag: '"full-wordpress:234123-2026-08-26"' },
    });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const requestDeps = deps({ current: entry(), cache, fetcher });

    const cached = await handleRequest(
      new Request("https://service/full"),
      requestDeps,
      NOW,
    );

    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(cached.headers.get("etag")).toBe('"full-wordpress:234123-2026-08-26"');
    expect(fetcher).not.toHaveBeenCalled();

    cache.stored = undefined;
    requestDeps.fetcher = vi.fn(async () =>
      new Response(new Uint8Array([4]), {
        headers: { "content-type": "image/jpeg" },
      }),
    ) as unknown as typeof fetch;
    const uncached = await handleRequest(
      new Request("https://service/full"),
      requestDeps,
      NOW,
    );
    expect(uncached.headers.get("etag")).toBe(
      '"full-wordpress:234123-2026-08-26"',
    );
  });
});

describe("handleRequest request-time fallback", () => {
  it("retries one transient upstream failure and then serves the current image", async () => {
    const bytes = new Uint8Array([7, 8]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
      ) as unknown as typeof fetch;
    const promoteFallback = vi.fn(async () => null);

    const response = await handleRequest(
      new Request("https://service/full"),
      deps({ current: entry(), fetcher, promoteFallback }),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(promoteFallback).not.toHaveBeenCalled();
  });

  it.each(["preview", "full"] as const)("promotes a verified reserve and invalidates the failed %s cache", async (variant) => {
    const current = entry();
    const fallback = entry({
      photoId: "reserve-1",
      sourceUrl: "https://example.com/reserve.jpg",
      previewUrl: "https://example.com/reserve-preview.jpg",
      intendedDate: "2026-08-26",
      origin: "reserve",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9]), {
          headers: { "content-type": "image/jpeg" },
        }),
      ) as unknown as typeof fetch;
    const promoteFallback = vi.fn(async () => fallback);
    const requestDeps = deps({ current, fetcher, promoteFallback });

    const response = await handleRequest(
      new Request(variant === "full" ? "https://service/full" : "https://service/"),
      requestDeps,
      NOW,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([9]),
    );
    expect(promoteFallback).toHaveBeenCalledWith("wordpress:234123", NOW);
    expect(requestDeps.cache.deletes).toEqual([
      `https://service/_cache/image/${variant}/2026-08-26/wordpress:234123`,
    ]);
    expect(fetcher).toHaveBeenLastCalledWith(
      variant === "full" ? fallback.sourceUrl : fallback.previewUrl,
      expect.any(Object),
    );
  });

  it("returns 502 when no checked fallback image is available", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const promoteFallback = vi.fn(async () => null);

    const response = await handleRequest(
      new Request("https://service/full"),
      deps({ current: entry(), fetcher, promoteFallback }),
      NOW,
    );

    expect(response.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(promoteFallback).toHaveBeenCalledWith("wordpress:234123", NOW);
  });

  it("returns 502 when reserve verification itself is temporarily unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const promoteFallback = vi.fn(async () => {
      throw new Error("Flickr API timeout");
    });

    const response = await handleRequest(
      new Request("https://service/full"),
      deps({ current: entry(), fetcher, promoteFallback }),
      NOW,
    );

    expect(response.status).toBe(502);
  });

  it("serves a concurrently promoted current selection without promoting again", async () => {
    const original = entry();
    const concurrent = entry({
      photoId: "concurrent",
      sourceUrl: "https://example.com/concurrent.jpg",
      intendedDate: "2026-08-26",
      origin: "reserve",
    });
    const repository = new MemoryRepository(serviceState({ current: original }));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => {
        await repository.write(serviceState({ current: concurrent }));
        return new Response(null, { status: 404 });
      })
      .mockResolvedValueOnce(
        new Response(new Uint8Array([6, 7]), {
          headers: { "content-type": "image/jpeg" },
        }),
      ) as unknown as typeof fetch;
    let promotions = 0;
    const promoteFallback = vi.fn(async (failedPhotoId: string) => {
      const latest = await repository.read();
      if (latest.current?.photoId !== failedPhotoId) return latest.current ?? null;
      promotions += 1;
      await repository.write(serviceState({ current: concurrent }));
      return concurrent;
    });
    const requestDeps = deps({ current: original, fetcher, promoteFallback });
    requestDeps.repository = repository as unknown as StateRepository;

    const image = await handleRequest(
      new Request("https://service/full"),
      requestDeps,
      NOW,
    );
    const metadata = await handleRequest(
      new Request("https://service/today.json"),
      requestDeps,
      NOW,
    );

    expect(promotions).toBe(0);
    expect(promoteFallback).toHaveBeenCalledWith("wordpress:234123", NOW);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      new Uint8Array([6, 7]),
    );
    expect(await metadata.json()).toMatchObject({ photoId: "concurrent" });
  });

  it("single-flights simultaneous fallback requests for the same failed current", async () => {
    const original = entry();
    const fallback = entry({
      photoId: "race-fallback",
      sourceUrl: "https://example.com/race-fallback.jpg",
      origin: "reserve",
    });
    const repository = new PairedInitialReadRepository(
      serviceState({ current: original, reserve: [fallback] }),
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === original.sourceUrl) {
        return new Response(null, { status: 404 });
      }
      return new Response(new Uint8Array([8, 8]), {
        headers: { "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;
    const requestDeps = deps({ current: original, fetcher });
    requestDeps.repository = repository as unknown as StateRepository;
    const conditionalPromoter = vi.fn(
      async (failedPhotoId: string, nowMs: number) =>
        promoteAvailableReserveIfCurrent(
          {
            repository: repository as unknown as StateRepository,
            providers: {
              isAvailable: async () => true,
              isEligible: async () => true,
            },
            logger: requestDeps.logger,
          },
          failedPhotoId,
          nowMs,
        ),
    );
    requestDeps.promoteFallback = conditionalPromoter;

    const [first, second] = await Promise.all([
      handleRequest(new Request("https://service/full"), requestDeps, NOW),
      handleRequest(new Request("https://service/full"), requestDeps, NOW),
    ]);
    const metadata = await handleRequest(
      new Request("https://service/today.json"),
      requestDeps,
      NOW,
    );

    expect(conditionalPromoter).toHaveBeenCalledTimes(1);
    expect(repository.writeCalls).toHaveLength(1);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      new Uint8Array([8, 8]),
    );
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array([8, 8]),
    );
    expect(await metadata.json()).toMatchObject({ photoId: "race-fallback" });
  });

  it("treats cache lookup failures as a miss and still serves verified bytes", async () => {
    const cache = new MemoryCache();
    vi.spyOn(cache, "match").mockRejectedValue(new Error("cache unavailable"));
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([3]), {
        headers: { "content-type": "image/jpeg" },
      }),
    ) as unknown as typeof fetch;

    const response = await handleRequest(
      new Request("https://service/full"),
      deps({ current: entry(), cache, fetcher }),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([3]),
    );
  });

  it("serves a checked fallback even when old-cache invalidation fails", async () => {
    const cache = new MemoryCache();
    vi.spyOn(cache, "delete").mockRejectedValue(new Error("cache unavailable"));
    const fallback = entry({
      photoId: "reserve-2",
      sourceUrl: "https://example.com/reserve-2.jpg",
      origin: "reserve",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([4]), {
          headers: { "content-type": "image/jpeg" },
        }),
      ) as unknown as typeof fetch;

    const response = await handleRequest(
      new Request("https://service/full"),
      deps({ current: entry(), cache, fetcher, promoteFallback: async () => fallback }),
      NOW,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([4]),
    );
  });
});
