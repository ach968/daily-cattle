import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { STATE_KEY } from "../src/config";
import type { AppEnv, ServiceState } from "../src/model";
import {
  parseServiceState,
  StateRepository,
  StateValidationError,
} from "../src/state";
import { eligiblePhoto, entry, serviceState } from "./factories";

interface KvDouble {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

function kvWithValue(value: string | null): KvDouble {
  return {
    get: vi.fn().mockResolvedValue(value),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function repository(kv: KvDouble): StateRepository {
  return new StateRepository(kv as unknown as Pick<KVNamespace, "get" | "put">);
}

function persisted(state: ServiceState): KvDouble {
  return kvWithValue(JSON.stringify(state));
}

function providerEntry(providerId: string) {
  return entry({ providerId, photoId: `wordpress:${providerId}` });
}

describe("StateRepository.read", () => {
  it("requires only the KV and AI bindings in the Worker environment", () => {
    expectTypeOf<AppEnv>().toEqualTypeOf<{
      STATE: KVNamespace;
      AI: Ai;
    }>();
  });

  it("returns an empty versioned state when KV has no value", async () => {
    const repo = repository(kvWithValue(null));

    await expect(repo.read()).resolves.toEqual({
      schemaVersion: 2,
      reserve: [],
      recentPhotoIds: [],
    });
  });

  it("returns independent empty collections on repeated reads", async () => {
    const repo = repository(kvWithValue(null));
    const first = await repo.read();
    first.reserve.push(providerEntry("local-mutation"));
    first.recentPhotoIds.push("local-mutation");

    await expect(repo.read()).resolves.toEqual({
      schemaVersion: 2,
      reserve: [],
      recentPhotoIds: [],
    });
  });

  it("returns a valid complete state", async () => {
    const state = serviceState({
      current: providerEntry("current"),
      next: { ...providerEntry("next"), intendedDate: "2026-08-27" },
      reserve: [providerEntry("reserve")],
      recentPhotoIds: ["served-1"],
      lastPreparation: {
        at: "2026-08-26T23:45:00.000Z",
        status: "success",
        detail: "prepared next image",
      },
    });

    await expect(repository(persisted(state)).read()).resolves.toEqual(state);
  });

  it("uses globally namespaced provider identities", () => {
    expect(eligiblePhoto()).toMatchObject({
      provider: "wordpress",
      providerId: "234123",
      photoId: "wordpress:234123",
    });
  });

  it("allows entries without optional creator attribution", () => {
    const photo = entry();
    const { photographer: _photographer, photographerUrl: _photographerUrl, ...withoutCreator } = photo;

    expect(
      parseServiceState({ ...serviceState(), current: withoutCreator }),
    ).toEqual({ ...serviceState(), current: withoutCreator });
  });

  it("rejects a selection whose provider ID differs from its global photo ID", () => {
    expect(() =>
      parseServiceState({
        ...serviceState(),
        current: { ...entry(), providerId: "different" },
      }),
    ).toThrow("selection provider ID does not match its global photo ID");
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["a non-object record", "[]"],
    ["the wrong schema version", JSON.stringify({ schemaVersion: 1, reserve: [], recentPhotoIds: [] })],
    [
      "an oversized reserve",
      JSON.stringify(
        serviceState({
          reserve: Array.from({ length: 10 }, (_, index) =>
            providerEntry(`reserve-${index}`),
          ),
        }),
      ),
    ],
    ["too much recent history", JSON.stringify(serviceState({ recentPhotoIds: Array.from({ length: 31 }, (_, index) => `served-${index}`) }))],
    ["duplicate selection IDs", JSON.stringify(serviceState({ current: providerEntry("duplicate"), reserve: [providerEntry("duplicate")] }))],
    ["an invalid intended date", JSON.stringify(serviceState({ next: entry({ intendedDate: "2026-02-30" }) }))],
    ["an invalid scoring timestamp", JSON.stringify(serviceState({ next: entry({ scoredAt: "yesterday" }) }))],
    ["a non-ISO scoring timestamp", JSON.stringify(serviceState({ next: entry({ scoredAt: "0" }) }))],
    ["a non-finite score component", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, technical: null as unknown as number } }) }))],
    ["an out-of-bounds score component", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, technical: 31 } }) }))],
    ["a fractional score component", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, subject: 27.5 } }) }))],
    ["a mismatched quality total", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, total: 89 } }) }))],
    ["an inconsistent passing flag", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, passed: false } }) }))],
    ["a passing flag with a hard rejection", JSON.stringify(serviceState({ next: entry({ quality: { ...entry().quality, hardRejects: ["watermark"] } }) }))],
    ["an undersized source", JSON.stringify(serviceState({ next: entry({ width: 1919 }) }))],
    ["a portrait source", JSON.stringify(serviceState({ next: entry({ width: 1920, height: 2560 }) }))],
    ["an unknown photo provider", JSON.stringify(serviceState({ next: entry({ provider: "unknown" as never }) }))],
    ["a legacy Flickr photo provider", JSON.stringify(serviceState({ next: entry({ provider: "flickr" as never }) }))],
  ])("rejects %s instead of silently resetting", async (_label, value) => {
    await expect(repository(kvWithValue(value)).read()).rejects.toBeInstanceOf(
      StateValidationError,
    );
  });
});

describe("StateRepository.write", () => {
  it("writes the complete state atomically to one versioned key", async () => {
    const kv = kvWithValue(null);
    const state = serviceState({ reserve: [providerEntry("reserve-1")] });

    await repository(kv).write(state);

    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(STATE_KEY, JSON.stringify(state));
  });

  it("rejects an invalid in-memory state before writing", async () => {
    const kv = kvWithValue(null);
    const invalid = serviceState({
      reserve: [entry({ photoId: "same" }), entry({ photoId: "same" })],
    });

    await expect(repository(kv).write(invalid)).rejects.toBeInstanceOf(
      StateValidationError,
    );
    expect(kv.put).not.toHaveBeenCalled();
  });
});
