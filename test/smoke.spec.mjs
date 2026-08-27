import { describe, expect, it } from "vitest";

import { runSmoke } from "../scripts/smoke.mjs";

const link =
  '<https://service.test/today.json>; rel="describedby", ' +
  '<https://www.flickr.com/photos/example/123>; rel="canonical"';

function imageResponse(linkHeader = link) {
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    headers: {
      "content-type": "image/jpeg",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60",
      etag: '"photo-123"',
      link: linkHeader,
    },
  });
}

function metadataResponse() {
  return Response.json({
    photoId: "123",
    date: "2026-08-26",
    width: 3840,
    height: 2160,
    license: "CC BY",
    sourceUrl: "https://live.staticflickr.com/source.jpg",
    pageUrl: "https://www.flickr.com/photos/example/123",
  });
}

describe("runSmoke", () => {
  it("rejects a second image response missing a Link relation", async () => {
    let imageCalls = 0;
    const fetcher = async (input) => {
      if (String(input).endsWith("/today.json")) return metadataResponse();
      imageCalls += 1;
      return imageCalls === 1
        ? imageResponse()
        : imageResponse(
            '<https://www.flickr.com/photos/example/123>; rel="canonical"',
          );
    };

    await expect(runSmoke("https://service.test", fetcher)).rejects.toThrow(
      /describedby/,
    );
  });
});
