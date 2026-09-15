import { describe, expect, it } from "vitest";

// @ts-expect-error smoke.mjs is an untyped Node CLI module.
import { runSmoke } from "../scripts/smoke.mjs";

const SERVICE_URL = "https://cattle-pic.example";

function responseFor(url: string, metadata: Record<string, unknown>): Response {
  if (url === `${SERVICE_URL}/` || url === `${SERVICE_URL}/today` || url === `${SERVICE_URL}/full`) {
    return new Response(new Uint8Array(url.endsWith("/full") ? [4, 5, 6, 7] : [1, 2, 3]), {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=43200",
        "content-type": "image/jpeg",
        etag: '"source-wordpress:234123-2026-08-26"',
        link:
          `<${SERVICE_URL}/today.json>; rel="describedby", ` +
          `<${metadata.pageUrl}>; rel="canonical"`,
      },
    });
  }
  if (url === `${SERVICE_URL}/today.json`) return Response.json(metadata);
  throw new Error(`unexpected URL ${url}`);
}

describe("runSmoke", () => {
  it("rejects an unavailable full-resolution endpoint", async () => {
    await expect(runSmoke(SERVICE_URL, async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/full")) return new Response(null, { status: 502 });
      return responseFor(url, {});
    })).rejects.toThrow("image endpoint returned HTTP 502");
  });

  it("rejects inconsistent repeated full-resolution responses", async () => {
    let fullCalls = 0;
    await expect(runSmoke(SERVICE_URL, async (input: string | URL | Request) => {
      const url = String(input);
      const response = responseFor(url, {});
      if (url.endsWith("/full") && ++fullCalls === 2) {
        return new Response(new Uint8Array([9]), { headers: response.headers });
      }
      return response;
    })).rejects.toThrow("repeated /full responses differ");
  });

  it("accepts matching WordPress image and metadata hosts", async () => {
    const metadata = {
      provider: "wordpress",
      providerId: "234123",
      photoId: "wordpress:234123",
      date: "2026-08-26",
      slot: "2026-08-26T12:00:00.000Z",
      width: 2800,
      height: 2100,
      license: "CC0",
      pageUrl: "https://wordpress.org/photos/photo/296a697b04/",
      sourceUrl: "https://pd.w.org/2026/07/example.jpg",
      displayUrl: "https://pd.w.org/2026/07/example-1024x768.jpg",
    };

    await expect(
      runSmoke(SERVICE_URL, (input: string | URL | Request) =>
        Promise.resolve(responseFor(String(input), metadata)),
      ),
    ).resolves.toMatchObject({ photoId: "wordpress:234123" });
  });

  it("accepts matching Wikimedia Commons image and metadata hosts", async () => {
    const metadata = {
      provider: "commons",
      providerId: "123",
      photoId: "commons:123",
      date: "2026-08-26",
      slot: "2026-08-26T12:00:00.000Z",
      width: 4032,
      height: 3024,
      license: "CC BY-SA",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Cattle_pasture.jpg",
      sourceUrl: "https://upload.wikimedia.org/original.jpg",
      displayUrl: "https://upload.wikimedia.org/preview.jpg",
    };

    await expect(
      runSmoke(SERVICE_URL, (input: string | URL | Request) =>
        Promise.resolve(responseFor(String(input), metadata)),
      ),
    ).resolves.toMatchObject({ photoId: "commons:123" });
  });

  it.each([
    [
      "a photo ID without its provider prefix",
      { photoId: "123" },
      "photoId must be provider-prefixed",
    ],
    [
      "a source URL outside the selected provider host",
      { sourceUrl: "https://pd.w.org/2026/07/example.jpg" },
      "commons source URL must use upload.wikimedia.org",
    ],
    [
      "missing display image metadata",
      { displayUrl: undefined },
      "displayUrl must be a non-empty string",
    ],
  ])("rejects %s", async (_description, overrides, message) => {
    const metadata = {
      provider: "commons",
      providerId: "123",
      photoId: "commons:123",
      date: "2026-08-26",
      slot: "2026-08-26T12:00:00.000Z",
      width: 4032,
      height: 3024,
      license: "CC BY-SA",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Cattle_pasture.jpg",
      sourceUrl: "https://upload.wikimedia.org/original.jpg",
      displayUrl: "https://upload.wikimedia.org/preview.jpg",
      ...overrides,
    };

    await expect(
      runSmoke(SERVICE_URL, (input: string | URL | Request) =>
        Promise.resolve(responseFor(String(input), metadata)),
      ),
    ).rejects.toThrow(message);
  });
});
