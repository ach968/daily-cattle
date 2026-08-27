import { describe, expect, it, vi } from "vitest";

import {
  OUTBOUND_USER_AGENT,
  PROVIDER_SEARCH_TERMS,
  WORDPRESS_ENDPOINT,
  WORDPRESS_LANDSCAPE_ORIENTATION_ID,
} from "../src/config";
import type { OperationalLogger } from "../src/lifecycle";
import type { EligiblePhoto } from "../src/model";
import { ProviderTransientError } from "../src/provider";
import { WordPressPhotoClient } from "../src/wordpress";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function featuredMedia(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 234124,
    media_type: "image",
    mime_type: "image/jpeg",
    source_url: "https://pd.w.org/2026/07/example.jpg",
    media_details: {
      width: 2800,
      height: 2100,
      sizes: {
        large: {
          source_url: "https://pd.w.org/2026/07/example-1024x768.jpg",
        },
      },
    },
    ...overrides,
  };
}

function photo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 234123,
    featured_media: 234124,
    status: "publish",
    type: "photo",
    link: "https://wordpress.org/photos/photo/296a697b04/",
    content: { rendered: "<p>Cattle grazing on a grassy pasture.</p>" },
    "photo-orientations": [23],
    _embedded: {
      author: [
        {
          name: "Josthin Medina Daniels",
          link: "https://wordpress.org/photos/author/josthin2409/",
        },
      ],
      "wp:featuredmedia": [featuredMedia()],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function fetchMock(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

class CapturedLogger implements OperationalLogger {
  readonly infos: Record<string, unknown>[] = [];
  readonly errors: Record<string, unknown>[] = [];

  info(event: Record<string, unknown>): void {
    this.infos.push(event);
  }

  error(event: Record<string, unknown>): void {
    this.errors.push(event);
  }
}

function storedPhoto(overrides: Partial<EligiblePhoto> = {}): EligiblePhoto {
  return {
    provider: "wordpress",
    providerId: "234123",
    photoId: "wordpress:234123",
    title: "Cattle grazing on a grassy pasture.",
    photographer: "Josthin Medina Daniels",
    photographerUrl: "https://wordpress.org/photos/author/josthin2409/",
    pageUrl: "https://wordpress.org/photos/photo/296a697b04/",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://pd.w.org/2026/07/example.jpg",
    previewUrl: "https://pd.w.org/2026/07/example-1024x768.jpg",
    width: 2800,
    height: 2100,
    ...overrides,
  };
}

describe("WordPressPhotoClient.search", () => {
  it("sends each configured landscape query and normalizes deduplicated CC0 candidates", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const logger = new CapturedLogger();
    const duplicate = photo({ id: 234123 });
    const fetcher = fetchMock(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      const term = url.searchParams.get("search");
      if (term === "cattle pasture") return jsonResponse([duplicate]);
      if (term === "cows grazing") return jsonResponse([duplicate]);
      return jsonResponse([]);
    });
    const client = new WordPressPhotoClient(fetcher, logger);

    const candidates = await client.search(NOW, "recent");

    expect(candidates).toEqual([
      {
        searchRank: 0,
        photo: storedPhoto(),
      },
    ]);
    expect(requests).toHaveLength(5);
    expect(requests.map(({ url }) => url.origin + url.pathname)).toEqual(
      Array(5).fill(WORDPRESS_ENDPOINT),
    );
    expect(new Set(requests.map(({ url }) => url.searchParams.get("search")))).toEqual(
      new Set(PROVIDER_SEARCH_TERMS),
    );
    for (const { url, init } of requests) {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        _embed: "1",
        "photo-orientations": String(WORDPRESS_LANDSCAPE_ORIENTATION_ID),
        per_page: "20",
        search: expect.any(String),
        orderby: "date",
        order: "desc",
        page: "1",
      });
      expect(init?.headers).toEqual({ "User-Agent": OUTBOUND_USER_AGENT });
    }
    expect(logger.infos).toHaveLength(5);
    expect(logger.infos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "provider_search",
          provider: "wordpress",
          query: "cattle pasture",
          pass: "recent",
          returnedCount: 1,
          eligibleCount: 1,
          rejected: { schema: 0, media: 0, dimensions: 0, url: 0 },
        }),
      ]),
    );
    for (const event of logger.infos) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("_embedded");
      expect(serialized).not.toContain("example.jpg");
    }
  });

  it("uses relevance ordering for the all-date pass and keeps each photo's first stable rank", async () => {
    const logger = new CapturedLogger();
    const calls: URL[] = [];
    const fetcher = fetchMock(async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.searchParams.get("search") === "cattle pasture") {
        return jsonResponse([photo({ id: 1 }), photo({ id: 2 })]);
      }
      if (url.searchParams.get("search") === "cows grazing") {
        return jsonResponse([photo({ id: 2 })]);
      }
      return jsonResponse([]);
    });
    const client = new WordPressPhotoClient(fetcher, logger);

    const candidates = await client.search(NOW, "all");

    expect(calls).toHaveLength(5);
    expect(calls.every((url) => url.searchParams.get("orderby") === "relevance")).toBe(
      true,
    );
    expect(candidates.map((candidate) => [candidate.photo.providerId, candidate.searchRank])).toEqual([
      ["1", 0],
      ["2", 1],
    ]);
  });

  it("rejects records that violate the published landscape JPEG contract", async () => {
    const logger = new CapturedLogger();
    const invalid = [
      photo({ status: "draft" }),
      photo({ "photo-orientations": [24] }),
      photo({ _embedded: {} }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ media_type: "video" })],
        },
      }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ mime_type: "image/png" })],
        },
      }),
      photo({ content: { rendered: 123 } }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ media_details: { width: 1919, height: 1080, sizes: { large: { source_url: "https://pd.w.org/preview.jpg" } } } })],
        },
      }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ media_details: { width: 1920, height: 1079, sizes: { large: { source_url: "https://pd.w.org/preview.jpg" } } } })],
        },
      }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ media_details: { width: 1920, height: 2560, sizes: { large: { source_url: "https://pd.w.org/preview.jpg" } } } })],
        },
      }),
      photo({ link: "http://wordpress.org/photos/photo/296a697b04/" }),
      photo({
        _embedded: {
          author: [{ name: "Ada", link: "https://wordpress.org/photos/author/ada/" }],
          "wp:featuredmedia": [featuredMedia({ source_url: "http://pd.w.org/full.jpg" })],
        },
      }),
    ];
    const fetcher = fetchMock(async (input) =>
      new URL(String(input)).searchParams.get("search") === "cattle pasture"
        ? jsonResponse(invalid)
        : jsonResponse([]),
    );
    const client = new WordPressPhotoClient(fetcher, logger);

    await expect(client.search(NOW, "recent")).resolves.toEqual([]);

    expect(logger.infos[0]).toMatchObject({
      returnedCount: invalid.length,
      eligibleCount: 0,
      rejected: { schema: 3, media: 3, dimensions: 3, url: 2 },
    });
  });

  it("rejects photo posts without a matching featured-media relation", async () => {
    const logger = new CapturedLogger();
    const missingRelation = photo();
    delete missingRelation.featured_media;
    const fetcher = fetchMock(async (input) =>
      new URL(String(input)).searchParams.get("search") === "cattle pasture"
        ? jsonResponse([missingRelation, photo({ featured_media: 999999 })])
        : jsonResponse([]),
    );
    const client = new WordPressPhotoClient(fetcher, logger);

    await expect(client.search(NOW, "recent")).resolves.toEqual([]);

    expect(logger.infos[0]).toMatchObject({
      returnedCount: 2,
      eligibleCount: 0,
      rejected: { schema: 0, media: 2, dimensions: 0, url: 0 },
    });
  });

  it("only raises a transient error when every configured query transiently fails", async () => {
    const logger = new CapturedLogger();
    const allFailed = new WordPressPhotoClient(
      fetchMock(async () => new Response(null, { status: 503 })),
      logger,
    );

    await expect(allFailed.search(NOW, "recent")).rejects.toBeInstanceOf(
      ProviderTransientError,
    );

    const partialFailure = new WordPressPhotoClient(
      fetchMock(async (input) =>
        new URL(String(input)).searchParams.get("search") === "cattle pasture"
          ? new Response(null, { status: 503 })
          : jsonResponse([]),
      ),
      new CapturedLogger(),
    );
    await expect(partialFailure.search(NOW, "recent")).resolves.toEqual([]);
  });
});

describe("WordPressPhotoClient revalidation", () => {
  it("delegates availability checks to the source checker", async () => {
    const fetcher = fetchMock(async (_input, init) => {
      expect(init?.method).toBe("HEAD");
      return new Response(null, {
        headers: { "content-type": "image/jpeg" },
      });
    });
    const client = new WordPressPhotoClient(fetcher, new CapturedLogger());

    await expect(client.isAvailable(storedPhoto())).resolves.toBe(true);
  });

  it("confirms stored attribution against a strict live record", async () => {
    const fetcher = fetchMock(async (input, init) => {
      const url = new URL(String(input));
      expect(url.href).toBe(`${WORDPRESS_ENDPOINT}/234123?_embed=1`);
      expect(init?.headers).toEqual({ "User-Agent": OUTBOUND_USER_AGENT });
      return jsonResponse(photo());
    });
    const client = new WordPressPhotoClient(fetcher, new CapturedLogger());

    await expect(client.isEligible(storedPhoto())).resolves.toBe(true);
  });

  it.each([
    ["a changed landing page", photo({ link: "https://wordpress.org/photos/photo/changed/" })],
    ["a changed full source URL", photo({
      _embedded: {
        author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
        "wp:featuredmedia": [featuredMedia({ source_url: "https://pd.w.org/changed.jpg" })],
      },
    })],
    ["a mismatched record ID", photo({ id: 999 })],
  ])("returns false for %s", async (_label, response) => {
    const client = new WordPressPhotoClient(
      fetchMock(async () => jsonResponse(response)),
      new CapturedLogger(),
    );

    await expect(client.isEligible(storedPhoto())).resolves.toBe(false);
  });

  it.each([
    ["an HTTP landing page", photo({ link: "http://wordpress.org/photos/photo/296a697b04/" })],
    ["an FTP full source URL", photo({
      _embedded: {
        author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
        "wp:featuredmedia": [featuredMedia({ source_url: "ftp://pd.w.org/example.jpg" })],
      },
    })],
  ])("returns false for a parseable but disallowed live URL: %s", async (_label, response) => {
    const client = new WordPressPhotoClient(
      fetchMock(async () => jsonResponse(response)),
      new CapturedLogger(),
    );

    await expect(client.isEligible(storedPhoto())).resolves.toBe(false);
  });

  it.each([
    ["an unparseable landing page", photo({ link: "https://" })],
    ["an unparseable full source URL", photo({
      _embedded: {
        author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
        "wp:featuredmedia": [featuredMedia({ source_url: "https://" })],
      },
    })],
  ])("throws for malformed live URL metadata: %s", async (_label, response) => {
    const client = new WordPressPhotoClient(
      fetchMock(async () => jsonResponse(response)),
      new CapturedLogger(),
    );

    await expect(client.isEligible(storedPhoto())).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it.each([
    ["an unpublished post", photo({ status: "draft" })],
    ["non-JPEG embedded media", photo({
      _embedded: {
        author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
        "wp:featuredmedia": [featuredMedia({ mime_type: "image/png" })],
      },
    })],
    ["an undersized original", photo({
      _embedded: {
        author: [{ name: "Josthin Medina Daniels", link: "https://wordpress.org/photos/author/josthin2409/" }],
        "wp:featuredmedia": [featuredMedia({ media_details: { width: 1919, height: 1080, sizes: { large: { source_url: "https://pd.w.org/preview.jpg" } } } })],
      },
    })],
  ])("returns false when live metadata has a definitive hard-gate regression: %s", async (_label, response) => {
    const client = new WordPressPhotoClient(
      fetchMock(async () => jsonResponse(response)),
      new CapturedLogger(),
    );

    await expect(client.isEligible(storedPhoto())).resolves.toBe(false);
  });

  it.each([
    ["a missing record", new Response(null, { status: 404 }), false],
    ["a gone record", new Response(null, { status: 410 }), false],
    ["a rate limit", new Response(null, { status: 429 }), null],
    ["malformed JSON", new Response("not json", { status: 200 }), null],
    ["malformed record", jsonResponse({ id: 234123 }), null],
  ])("handles %s without trusting indeterminate data", async (_label, response, expected) => {
    const client = new WordPressPhotoClient(
      fetchMock(async () => response.clone()),
      new CapturedLogger(),
    );

    if (expected === null) {
      await expect(client.isEligible(storedPhoto())).rejects.toBeInstanceOf(
        ProviderTransientError,
      );
    } else {
      await expect(client.isEligible(storedPhoto())).resolves.toBe(expected);
    }
  });
});
