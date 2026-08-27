import { describe, expect, it, vi } from "vitest";

import type { PhotoProviderName } from "../src/model";
import type { PhotoProviderClient } from "../src/provider";
import { ProviderRegistry } from "../src/providers";
import { eligiblePhoto } from "./factories";

function providerClient(provider: PhotoProviderName): PhotoProviderClient {
  return {
    provider,
    search: vi.fn().mockResolvedValue([]),
    isAvailable: vi.fn().mockResolvedValue(true),
    isEligible: vi.fn().mockResolvedValue(true),
  };
}

describe("ProviderRegistry", () => {
  it("exposes WordPress followed by Commons and dispatches through the photo provider", async () => {
    const wordpress = providerClient("wordpress");
    const commons = providerClient("commons");
    const registry = new ProviderRegistry([wordpress, commons]);

    expect(registry.providers.map((provider) => provider.provider)).toEqual([
      "wordpress",
      "commons",
    ]);

    await expect(
      registry.isEligible(
        eligiblePhoto({
          provider: "commons",
          providerId: "42",
          photoId: "commons:42",
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      registry.isAvailable(
        eligiblePhoto({
          provider: "wordpress",
          providerId: "43",
          photoId: "wordpress:43",
        }),
      ),
    ).resolves.toBe(true);

    expect(commons.isEligible).toHaveBeenCalledOnce();
    expect(wordpress.isEligible).not.toHaveBeenCalled();
    expect(wordpress.isAvailable).toHaveBeenCalledOnce();
    expect(commons.isAvailable).not.toHaveBeenCalled();
  });

  it("keeps its required order when the construction array is later mutated", () => {
    const wordpress = providerClient("wordpress");
    const commons = providerClient("commons");
    const supplied = [wordpress, commons];
    const registry = new ProviderRegistry(supplied);

    supplied.reverse();

    expect(registry.providers.map((provider) => provider.provider)).toEqual([
      "wordpress",
      "commons",
    ]);
  });

  it("does not allow callers to mutate its exposed provider order", () => {
    const registry = new ProviderRegistry([
      providerClient("wordpress"),
      providerClient("commons"),
    ]);

    expect(() => (registry.providers as PhotoProviderClient[]).reverse()).toThrow(
      TypeError,
    );
    expect(registry.providers.map((provider) => provider.provider)).toEqual([
      "wordpress",
      "commons",
    ]);
  });

  it.each([
    ["duplicate providers", ["wordpress", "wordpress"]],
    ["missing WordPress", ["commons"]],
    ["Commons before WordPress", ["commons", "wordpress"]],
    ["an extra provider", ["wordpress", "commons", "wordpress"]],
  ] as const)("rejects %s", (_description, names) => {
    const clients = names.map((provider) => providerClient(provider));

    expect(() => new ProviderRegistry(clients)).toThrow();
  });

  it("fails closed for unknown or globally mismatched providers without calling a client", async () => {
    const wordpress = providerClient("wordpress");
    const commons = providerClient("commons");
    const registry = new ProviderRegistry([wordpress, commons]);

    await expect(
      registry.isEligible(
        eligiblePhoto({
          provider: "commons",
          providerId: "42",
          photoId: "wordpress:42",
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      registry.isAvailable(
        eligiblePhoto({
          provider: "unknown" as never,
          providerId: "42",
          photoId: "unknown:42",
        }),
      ),
    ).resolves.toBe(false);

    expect(wordpress.isEligible).not.toHaveBeenCalled();
    expect(commons.isEligible).not.toHaveBeenCalled();
    expect(wordpress.isAvailable).not.toHaveBeenCalled();
    expect(commons.isAvailable).not.toHaveBeenCalled();
  });
});
