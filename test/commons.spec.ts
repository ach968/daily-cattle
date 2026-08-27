import { describe, expect, it, vi } from "vitest";

import { CommonsPhotoClient } from "../src/commons";
import { ProviderTransientError } from "../src/provider";
import { eligiblePhoto } from "./factories";

type Metadata = { value: string };

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

function imageInfo(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://upload.wikimedia.org/original.jpg",
    thumburl: "https://upload.wikimedia.org/preview.jpg",
    width: 4032,
    height: 3024,
    mime: "image/jpeg",
    mediatype: "BITMAP",
    extmetadata: {
      LicenseShortName: { value: "CC BY-SA 4.0" },
      LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
      Artist: { value: "<a href=\"https://commons.wikimedia.org/wiki/User:Ada\">Ada Lovelace</a>" },
      ImageDescription: { value: "<p>Cattle <b>grazing</b> in a pasture.</p>" },
    } satisfies Record<string, Metadata>,
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    pageid: 123,
    title: "File:Cattle pasture.jpg",
    canonicalurl: "https://commons.wikimedia.org/wiki/File:Cattle_pasture.jpg",
    imageinfo: [imageInfo()],
    ...overrides,
  };
}

function apiResponse(pages: unknown[] = [page()]) {
  return { query: { pages } };
}

function logger() {
  return { info: vi.fn(), error: vi.fn() };
}

function commonsPhoto(overrides: Record<string, unknown> = {}) {
  return eligiblePhoto({
    provider: "commons",
    providerId: "123",
    photoId: "commons:123",
    title: "Cattle grazing in a pasture.",
    photographer: "Ada Lovelace",
    photographerUrl: "https://commons.wikimedia.org/wiki/User:Ada",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Cattle_pasture.jpg",
    license: "CC BY-SA",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    sourceUrl: "https://upload.wikimedia.org/original.jpg",
    previewUrl: "https://upload.wikimedia.org/preview.jpg",
    width: 4032,
    height: 3024,
    ...overrides,
  });
}

describe("CommonsPhotoClient.search", () => {
  it("sends strict Action API parameters and descriptive user agents", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = fetchMock(async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return jsonResponse(apiResponse());
    });
    const client = new CommonsPhotoClient(fetcher, logger());

    const candidates = await client.search(Date.parse("2026-08-26T12:00:00Z"), "recent");

    expect(candidates[0]).toMatchObject({
      searchRank: 0,
      photo: commonsPhoto(),
    });
    expect(calls).toHaveLength(5);
    const params = calls[0]!.url.searchParams;
    expect(params.get("action")).toBe("query");
    expect(params.get("generator")).toBe("search");
    expect(params.get("gsrnamespace")).toBe("6");
    expect(params.get("gsrsearch")).toBe("filetype:bitmap cattle pasture");
    expect(params.get("gsrlimit")).toBe("20");
    expect(params.get("gsrsort")).toBe("create_timestamp_desc");
    expect(params.get("prop")).toBe("info|imageinfo");
    expect(params.get("inprop")).toBe("url");
    expect(params.get("iiprop")).toBe("url|size|mime|mediatype|extmetadata");
    expect(params.get("iiurlwidth")).toBe("1024");
    expect(params.get("format")).toBe("json");
    expect(params.get("formatversion")).toBe("2");
    expect(params.get("maxlag")).toBe("5");
    expect(calls.every(({ init }) => init?.headers instanceof Headers)).toBe(true);
    const headers = calls[0]!.init!.headers as Headers;
    expect(headers.get("user-agent")).toContain("cattle-pic/1.0");
    expect(headers.get("api-user-agent")).toContain("cattle-pic/1.0");
  });

  it("uses relevance for the all-results pass", async () => {
    const urls: URL[] = [];
    const client = new CommonsPhotoClient(
      fetchMock(async (input) => {
        urls.push(new URL(String(input)));
        return jsonResponse(apiResponse([]));
      }),
      logger(),
    );

    await client.search(Date.now(), "all");

    expect(urls).toHaveLength(5);
    expect(urls.every((url) => !url.searchParams.has("gsrsort"))).toBe(true);
  });

  it("retries maxlag responses with deterministic backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = new CommonsPhotoClient(
      fetchMock(async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: { code: "maxlag", info: "lagged" } })
          : jsonResponse(apiResponse());
      }),
      logger(),
      { delay: async (milliseconds: number) => { delays.push(milliseconds); }, random: () => 0 },
    );

    await expect(client.search(Date.now(), "all")).resolves.toHaveLength(1);

    expect(calls).toBe(6);
    expect(delays).toEqual([125]);
  });

  it("honors Retry-After and caches successful metadata responses within the instance", async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = new CommonsPhotoClient(
      fetchMock(async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: { code: "ratelimited", info: "slow down" } }, {
              status: 429,
              headers: { "retry-after": "3" },
            })
          : jsonResponse(apiResponse());
      }),
      logger(),
      { delay: async (milliseconds: number) => { delays.push(milliseconds); }, random: () => 0 },
    );

    await client.search(Date.now(), "all");
    await client.search(Date.now(), "all");

    expect(calls).toBe(6);
    expect(delays).toEqual([3000]);
  });

  it("follows generator-search continuation tokens in order and keeps the rank after rejected pages", async () => {
    const urls: URL[] = [];
    const client = new CommonsPhotoClient(
      fetchMock(async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.searchParams.get("gsrsearch") !== "filetype:bitmap cattle pasture") {
          return jsonResponse(apiResponse([]));
        }
        if (!url.searchParams.has("gsroffset")) {
          return jsonResponse({
            query: { pages: [page({ imageinfo: [imageInfo({ width: 1919 })] })] },
            continue: { continue: "gsroffset||", gsroffset: 20 },
          });
        }
        return jsonResponse(apiResponse([page({ pageid: 456, title: "File:Later cattle.jpg" })]));
      }),
      logger(),
    );

    const candidates = await client.search(Date.now(), "all");

    expect(candidates.map((candidate) => [candidate.photo.providerId, candidate.searchRank])).toEqual([
      ["456", 1],
    ]);
    expect(urls).toHaveLength(6);
    expect(urls[1]!.searchParams.get("continue")).toBe("gsroffset||");
    expect(urls[1]!.searchParams.get("gsroffset")).toBe("20");
  });

  it("bounds continuation processing to three pages per search phrase", async () => {
    const fetcher = fetchMock(async (input) => {
      const url = new URL(String(input));
      const previous = url.searchParams.get("gsrcontinue");
      const pageNumber = previous ? Number(previous.slice(-1)) + 1 : 1;
      return jsonResponse({
        query: { pages: [] },
        continue: { continue: "-||", gsrcontinue: `next-page-${pageNumber}` },
      });
    });
    const client = new CommonsPhotoClient(
      fetcher,
      logger(),
    );

    await client.search(Date.now(), "all");

    expect(fetcher).toHaveBeenCalledTimes(15);
  });

  it.each([
    ["a numeric generic token", { continue: 0, gsroffset: 20 }],
    ["a missing module token", { continue: "gsroffset||" }],
    ["an empty module token name", { continue: "gsroffset||", "": "20" }],
    ["an empty generic token", { continue: "", gsroffset: 20 }],
    ["a null module token", { continue: "gsroffset||", gsroffset: null }],
    ["a negative numeric offset", { continue: "gsroffset||", gsroffset: -1 }],
    ["a fractional numeric offset", { continue: "gsroffset||", gsroffset: 1.5 }],
    ["a negative string offset", { continue: "gsroffset||", gsroffset: "-1" }],
    ["a fractional string offset", { continue: "gsroffset||", gsroffset: "1.5" }],
  ])("rejects malformed continuation with %s", async (_reason, continuation) => {
    const fetcher = fetchMock(async () =>
      jsonResponse({ query: { pages: [] }, continue: continuation }),
    );
    const client = new CommonsPhotoClient(fetcher, logger());

    await expect(client.search(Date.now(), "all")).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "CC0"],
    ["Public Domain Mark 1.0", "https://creativecommons.org/publicdomain/mark/1.0/", "Public Domain"],
    ["CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/", "CC BY"],
    ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", "CC BY"],
    ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", "CC BY"],
    ["CC BY-SA 2.0", "https://creativecommons.org/licenses/by-sa/2.0/", "CC BY-SA"],
    ["CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/", "CC BY-SA"],
    ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA"],
  ])("maps %s exactly", async (shortName, licenseUrl, license) => {
    const client = new CommonsPhotoClient(
      fetchMock(async () =>
        jsonResponse(
          apiResponse([
            page({
              imageinfo: [
                imageInfo({
                  extmetadata: {
                    LicenseShortName: { value: shortName },
                    LicenseUrl: { value: licenseUrl },
                    Artist: { value: "Ada Lovelace" },
                    ImageDescription: { value: "Cattle grazing" },
                  },
                }),
              ],
            }),
          ]),
        ),
      ),
      logger(),
    );

    const candidates = await client.search(Date.now(), "all");

    expect(candidates[0]?.photo).toMatchObject({ license, licenseUrl });
  });

  it("strips Commons HTML metadata and omits an unavailable creator URL", async () => {
    const client = new CommonsPhotoClient(
      fetchMock(async () =>
        jsonResponse(
          apiResponse([
            page({
              imageinfo: [
                imageInfo({
                  extmetadata: {
                    LicenseShortName: { value: "CC BY-SA 4.0" },
                    LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
                    Artist: { value: "<span>Ada &amp; Charles</span>" },
                    ImageDescription: { value: "<p>Cattle &amp; calves</p>" },
                  },
                }),
              ],
            }),
          ]),
        ),
      ),
      logger(),
    );

    const candidates = await client.search(Date.now(), "all");

    expect(candidates[0]?.photo).toMatchObject({
      photographer: "Ada & Charles",
      title: "Cattle & calves",
    });
    expect(candidates[0]?.photo.photographerUrl).toBeUndefined();
  });

  it("deduplicates by page ID, preserves API order, and logs grouped rejections", async () => {
    const logs = logger();
    let request = 0;
    const client = new CommonsPhotoClient(
      fetchMock(async () => {
        request += 1;
        return jsonResponse(
          apiResponse(
            request === 1
              ? [
                  page(),
                  page({ pageid: 456, title: "File:Second.jpg" }),
                  page({ pageid: 789, imageinfo: [imageInfo({ mime: "image/svg+xml" })] }),
                ]
              : [page()],
          ),
        );
      }),
      logs,
    );

    const candidates = await client.search(Date.now(), "all");

    expect(candidates.map((candidate) => [candidate.photo.providerId, candidate.searchRank])).toEqual([
      ["123", 0],
      ["456", 1],
    ]);
    expect(logs.info).toHaveBeenCalledTimes(5);
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "provider_search",
        provider: "commons",
        query: "cattle pasture",
        pass: "all",
        returned: 3,
        eligible: 2,
        rejections: expect.objectContaining({ media: 1 }),
      }),
    );
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain("extmetadata");
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain("original.jpg");
  });

  it.each([
    ["a noncommercial license", imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-NC 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-nc/4.0/" } } })],
    ["a no-derivatives license", imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-ND 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-nd/4.0/" } } })],
    ["a noncommercial share-alike license", imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-NC-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-nc-sa/4.0/" } } })],
    ["an unknown license", imageInfo({ extmetadata: { LicenseShortName: { value: "Free Art License" }, LicenseUrl: { value: "https://artlibre.org/licence/lal/en/" } } })],
    ["conflicting license metadata", imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" } } })],
    ["SVG", imageInfo({ mime: "image/svg+xml" })],
    ["non-bitmap media", imageInfo({ mediatype: "DRAWING" })],
    ["a non-image MIME type", imageInfo({ mime: "application/pdf" })],
    ["an invalid source URL", imageInfo({ url: "javascript:alert(1)" })],
    ["missing dimensions", imageInfo({ width: undefined })],
    ["undersized dimensions", imageInfo({ width: 1919 })],
    ["portrait dimensions", imageInfo({ width: 1920, height: 2400 })],
    ["malformed extmetadata", imageInfo({ extmetadata: { LicenseShortName: { value: 1 }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" } } })],
  ])("rejects %s", async (_reason, info) => {
    const client = new CommonsPhotoClient(
      fetchMock(async () => jsonResponse(apiResponse([page({ imageinfo: [info] })]))),
      logger(),
    );

    await expect(client.search(Date.now(), "all")).resolves.toEqual([]);
  });

  it("rejects a page without a canonical URL", async () => {
    const client = new CommonsPhotoClient(
      fetchMock(async () => jsonResponse(apiResponse([page({ canonicalurl: undefined })]))),
      logger(),
    );

    await expect(client.search(Date.now(), "all")).resolves.toEqual([]);
  });
});

describe("CommonsPhotoClient revalidation", () => {
  it("revalidates the stored original through pageids and source availability", async () => {
    const calls: URL[] = [];
    const client = new CommonsPhotoClient(
      fetchMock(async (input, init) => {
        if (init?.method === "HEAD") return new Response(null, { headers: { "content-type": "image/jpeg" } });
        calls.push(new URL(String(input)));
        return jsonResponse(apiResponse());
      }),
      logger(),
    );

    await expect(client.isEligible(commonsPhoto())).resolves.toBe(true);
    await expect(client.isAvailable(commonsPhoto())).resolves.toBe(true);

    expect(calls[0]!.searchParams.get("pageids")).toBe("123");
    expect(calls[0]!.searchParams.get("prop")).toBe("info|imageinfo");
    expect(calls[0]!.searchParams.get("iiprop")).toBe("url|size|mime|mediatype|extmetadata");
  });

  it.each([
    ["a missing page", apiResponse([]), commonsPhoto()],
    ["an affirmatively missing page", apiResponse([page({ missing: true, pageid: undefined })]), commonsPhoto()],
    ["a definitive missing-page API error", { error: { code: "missingtitle", info: "missing" } }, commonsPhoto()],
    ["a changed original URL", apiResponse([page({ imageinfo: [imageInfo({ url: "https://upload.wikimedia.org/changed.jpg" })] })]), commonsPhoto()],
    ["a changed license", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" } } })] })]), commonsPhoto()],
    ["a disallowed license", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-NC 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-nc/4.0/" } } })] })]), commonsPhoto()],
    ["an HTTP landing URL", apiResponse([page({ canonicalurl: "http://commons.wikimedia.org/wiki/File:Cattle_pasture.jpg" })]), commonsPhoto()],
    ["a credential-bearing landing URL", apiResponse([page({ canonicalurl: "https://user:pass@commons.wikimedia.org/wiki/File:Cattle_pasture.jpg" })]), commonsPhoto()],
    ["a non-Commons landing host", apiResponse([page({ canonicalurl: "https://example.com/wiki/File:Cattle_pasture.jpg" })]), commonsPhoto()],
    ["an FTP source URL", apiResponse([page({ imageinfo: [imageInfo({ url: "ftp://upload.wikimedia.org/original.jpg" })] })]), commonsPhoto()],
    ["a credential-bearing source URL", apiResponse([page({ imageinfo: [imageInfo({ url: "https://user:pass@upload.wikimedia.org/original.jpg" })] })]), commonsPhoto()],
    ["a non-upload source host", apiResponse([page({ imageinfo: [imageInfo({ url: "https://example.com/original.jpg" })] })]), commonsPhoto()],
    ["a JavaScript preview URL", apiResponse([page({ imageinfo: [imageInfo({ thumburl: "javascript:alert(1)" })] })]), commonsPhoto()],
    ["a non-upload preview host", apiResponse([page({ imageinfo: [imageInfo({ thumburl: "https://example.com/preview.jpg" })] })]), commonsPhoto()],
    ["an HTTP license URL", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "http://creativecommons.org/licenses/by-sa/4.0/" } } })] })]), commonsPhoto()],
    ["a credential-bearing license URL", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://user:pass@creativecommons.org/licenses/by-sa/4.0/" } } })] })]), commonsPhoto()],
    ["a non-allowlisted license host", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://example.com/licenses/by-sa/4.0/" } } })] })]), commonsPhoto()],
    ["a query-bearing license URL", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/?version=1" } } })] })]), commonsPhoto()],
    ["a dimension regression", apiResponse([page({ imageinfo: [imageInfo({ width: 1919 })] })]), commonsPhoto()],
    ["a media regression", apiResponse([page({ imageinfo: [imageInfo({ mediatype: "DRAWING" })] })]), commonsPhoto()],
  ])("returns false for %s", async (_reason, body, photo) => {
    const client = new CommonsPhotoClient(fetchMock(async () => jsonResponse(body)), logger());

    await expect(client.isEligible(photo)).resolves.toBe(false);
  });

  it.each([
    ["a missing query object", {}],
    ["multiple page records", { query: { pages: [page(), page({ pageid: 456 })] } }],
    ["a missing page ID", apiResponse([page({ pageid: undefined })])],
    ["a missing canonical URL", apiResponse([page({ canonicalurl: undefined })])],
    ["an unparseable canonical URL", apiResponse([page({ canonicalurl: "https://" })])],
    ["missing image information", apiResponse([page({ imageinfo: undefined })])],
    ["truncated image information", apiResponse([page({ imageinfo: [] })])],
    ["missing dimensions", apiResponse([page({ imageinfo: [imageInfo({ width: undefined })] })])],
    ["missing media schema", apiResponse([page({ imageinfo: [imageInfo({ mime: undefined })] })])],
    ["missing license metadata", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: {} })] })])],
    ["an unparseable license URL", apiResponse([page({ imageinfo: [imageInfo({ extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://" } } })] })])],
    ["an unparseable source URL", apiResponse([page({ imageinfo: [imageInfo({ url: "https://" })] })])],
    ["an unparseable preview URL", apiResponse([page({ imageinfo: [imageInfo({ thumburl: "https://" })] })])],
  ])("throws ProviderTransientError for successful JSON with %s", async (_reason, body) => {
    const client = new CommonsPhotoClient(
      fetchMock(async () => jsonResponse(body)),
      logger(),
    );

    await expect(client.isEligible(commonsPhoto())).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it.each([
    ["maxlag", jsonResponse({ error: { code: "maxlag", info: "lagged" } })],
    ["an API error", jsonResponse({ error: { code: "internal_api_error", info: "oops" } })],
    ["a rate limit", new Response(null, { status: 429 })],
    ["malformed JSON", new Response("nope", { headers: { "content-type": "application/json" } })],
  ])("throws ProviderTransientError for %s", async (_reason, response) => {
    const client = new CommonsPhotoClient(
      fetchMock(async () => response.clone()),
      logger(),
      { delay: async () => undefined, random: () => 0 },
    );

    await expect(client.isEligible(commonsPhoto())).rejects.toBeInstanceOf(ProviderTransientError);
  });
});
