import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const PRODUCTION_QUALITY_THRESHOLD = 75;

function currentUtcSlot(date) {
  const slot = new Date(date);
  slot.setUTCMinutes(0, 0, 0);
  slot.setUTCHours(slot.getUTCHours() < 12 ? 0 : 12);
  return slot.toISOString();
}

export async function runProductionHealthCheck(
  serviceUrl,
  fetcher = fetch,
  now = new Date(),
) {
  assert.ok(serviceUrl, "SERVICE_URL is required");
  const metadataUrl = new URL("/today.json", serviceUrl);
  const response = await fetcher(metadataUrl);
  assert.ok(response.ok, `/today.json returned HTTP ${response.status}`);

  const metadata = await response.json();
  assert.ok(metadata && typeof metadata === "object", "metadata must be an object");
  assert.equal(metadata.date, now.toISOString().slice(0, 10), "selection date is not today in UTC");
  assert.equal(metadata.slot, currentUtcSlot(now), "selection is not from the current 12-hour UTC slot");
  assert.notEqual(metadata.origin, "retained", "selection was retained from the previous UTC slot");
  assert.ok(
    metadata.origin === "fresh" || metadata.origin === "reserve",
    "selection origin must be fresh or reserve",
  );
  assert.ok(metadata.quality && typeof metadata.quality === "object", "quality metadata is required");
  assert.equal(metadata.quality.passed, true, "selection did not pass the quality gate");
  assert.ok(
    Number.isInteger(metadata.quality.total) &&
      metadata.quality.total >= PRODUCTION_QUALITY_THRESHOLD,
    `selection score is below ${PRODUCTION_QUALITY_THRESHOLD}`,
  );

  return {
    date: metadata.date,
    slot: metadata.slot,
    photoId: metadata.photoId,
    origin: metadata.origin,
    score: metadata.quality.total,
  };
}

async function main() {
  const result = await runProductionHealthCheck(process.env.SERVICE_URL);
  console.log(
    `Production healthy: ${result.photoId} for ${result.slot} ` +
      `(${result.origin}, score ${result.score})`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "production health check failed");
    process.exitCode = 1;
  });
}
