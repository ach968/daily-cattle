import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const PROVIDER_HOSTS = {
  wordpress: { page: "wordpress.org", source: "pd.w.org" },
  commons: { page: "commons.wikimedia.org", source: "upload.wikimedia.org" },
};

function requiredHeader(response, name) {
  const value = response.headers.get(name);
  assert.ok(value, `${name} header is required`);
  return value;
}

function linkForRelation(header, relation) {
  for (const match of header.matchAll(/<([^>]+)>\s*;\s*rel="?([^";,\s]+)"?/g)) {
    if (match[2] === relation) return match[1];
  }
  return null;
}

function isAbsoluteUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function matchesHost(value, expected) {
  return value === expected || value.endsWith(`.${expected}`);
}

function requiredMetadataString(metadata, name) {
  const value = metadata[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be a non-empty string`);
  return value;
}

function validateProviderMetadata(metadata, canonical) {
  const provider = requiredMetadataString(metadata, "provider");
  const hosts = PROVIDER_HOSTS[provider];
  assert.ok(hosts, "metadata provider must be wordpress or commons");
  const providerId = requiredMetadataString(metadata, "providerId");
  const photoId = requiredMetadataString(metadata, "photoId");
  const sourceUrl = requiredMetadataString(metadata, "sourceUrl");
  const displayUrl = requiredMetadataString(metadata, "displayUrl");
  const pageUrl = requiredMetadataString(metadata, "pageUrl");

  assert.equal(photoId, `${provider}:${providerId}`, "photoId must be provider-prefixed");
  assert.equal(pageUrl, canonical, "metadata and canonical Link disagree");
  assert.ok(isAbsoluteUrl(sourceUrl), "metadata sourceUrl must be HTTPS");
  assert.ok(isAbsoluteUrl(displayUrl), "metadata displayUrl must be HTTPS");
  assert.ok(isAbsoluteUrl(pageUrl), "metadata pageUrl must be HTTPS");
  assert.ok(
    matchesHost(new URL(pageUrl).hostname, hosts.page),
    `${provider} canonical URL must use ${hosts.page}`,
  );
  assert.ok(
    matchesHost(new URL(sourceUrl).hostname, hosts.source),
    `${provider} source URL must use ${hosts.source}`,
  );
  assert.ok(
    matchesHost(new URL(displayUrl).hostname, hosts.source),
    `${provider} display URL must use ${hosts.source}`,
  );
}

export async function runSmoke(serviceUrl, fetcher = fetch) {
  assert.ok(serviceUrl, "SERVICE_URL is required");
  const base = new URL(serviceUrl);
  const rootUrl = new URL("/", base);
  const imageUrl = new URL("/today", base);
  const metadataUrl = new URL("/today.json", base);

  const [root, first, second, metadataResponse] = await Promise.all([
    fetcher(rootUrl),
    fetcher(imageUrl),
    fetcher(imageUrl),
    fetcher(metadataUrl),
  ]);

  for (const response of [root, first, second]) {
    assert.ok(response.ok, `image endpoint returned HTTP ${response.status}`);
    assert.match(requiredHeader(response, "content-type"), /^image\//i);
    assert.equal(requiredHeader(response, "access-control-allow-origin"), "*");
    assert.ok(requiredHeader(response, "cache-control").includes("public"));
    requiredHeader(response, "etag");
  }

  const rootBytes = Buffer.from(await root.arrayBuffer());
  const firstBytes = Buffer.from(await first.arrayBuffer());
  const secondBytes = Buffer.from(await second.arrayBuffer());
  assert.ok(rootBytes.length > 0, "/ returned an empty image");
  assert.ok(firstBytes.length > 0, "/today returned an empty image");
  assert.ok(rootBytes.equals(firstBytes), "/ and /today responses differ");
  assert.ok(firstBytes.equals(secondBytes), "repeated /today responses differ");

  const linkHeaders = [root, first, second].map((response) =>
    requiredHeader(response, "link"),
  );
  for (const linkHeader of linkHeaders) {
    assert.equal(
      linkForRelation(linkHeader, "describedby"),
      metadataUrl.href,
      'Link rel="describedby" must identify /today.json',
    );
    assert.ok(
      linkForRelation(linkHeader, "canonical"),
      'Link rel="canonical" is required',
    );
  }
  assert.equal(
    linkHeaders[2],
    linkHeaders[0],
    "image endpoint Link headers differ",
  );
  const canonical = linkForRelation(linkHeaders[0], "canonical");

  assert.ok(
    metadataResponse.ok,
    `/today.json returned HTTP ${metadataResponse.status}`,
  );
  const metadata = await metadataResponse.json();
  assert.ok(metadata && typeof metadata === "object", "metadata must be an object");
  assert.match(metadata.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(
    metadata.slot,
    /^\d{4}-\d{2}-\d{2}T(?:00|12):00:00\.000Z$/,
    "metadata slot must identify a UTC 12-hour boundary",
  );
  assert.ok(Number.isInteger(metadata.width) && metadata.width >= 1920);
  assert.ok(Number.isInteger(metadata.height) && metadata.height >= 1080);
  assert.ok(metadata.width > metadata.height, "image must be landscape");
  assert.ok(
    ["CC BY", "CC BY-SA", "CC0", "Public Domain"].includes(metadata.license),
    "metadata license is not allowed",
  );
  validateProviderMetadata(metadata, canonical);

  return {
    photoId: metadata.photoId,
    date: metadata.date,
    slot: metadata.slot,
    width: metadata.width,
    height: metadata.height,
  };
}

async function main() {
  const result = await runSmoke(process.env.SERVICE_URL);
  console.log(
    `Smoke passed: ${result.photoId} for ${result.slot} (${result.width}x${result.height})`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "smoke test failed");
    process.exitCode = 1;
  });
}
