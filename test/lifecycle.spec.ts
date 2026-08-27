import { describe, expect, it } from "vitest";

import {
  promoteAvailableReserve,
  promoteAvailableReserveIfCurrent,
  runPreparation,
  runPromotion,
  type LifecycleDeps,
  type OperationalLogger,
  type ReservePromotionDeps,
} from "../src/lifecycle";
import type { ServiceState } from "../src/model";
import type { StateRepository } from "../src/state";
import type { SelectionEngine } from "../src/selector";
import { entry, quality, serviceState } from "./factories";

const PREPARATION_TIME = Date.parse("2026-08-26T23:45:00.000Z");
const PROMOTION_TIME = Date.parse("2026-08-27T00:00:00.000Z");

class MemoryRepository {
  readonly writeCalls: ServiceState[] = [];

  constructor(readonly initial: ServiceState) {}

  async read(): Promise<ServiceState> {
    return structuredClone(this.writeCalls.at(-1) ?? this.initial);
  }

  async write(state: ServiceState): Promise<void> {
    this.writeCalls.push(structuredClone(state));
  }

  get saved(): ServiceState | undefined {
    return this.writeCalls.at(-1);
  }
}

class MemoryLogger implements OperationalLogger {
  readonly infos: Record<string, unknown>[] = [];
  readonly errors: Record<string, unknown>[] = [];

  info(event: Record<string, unknown>): void {
    this.infos.push(event);
  }

  error(event: Record<string, unknown>): void {
    this.errors.push(event);
  }
}

interface HarnessOptions extends Partial<ServiceState> {
  prepared?: ServiceState;
  selectorError?: Error;
  unavailableIds?: string[];
  ineligibleIds?: string[];
  availabilityErrorIds?: string[];
  eligibilityErrorIds?: string[];
}

function lifecycleDeps(options: HarnessOptions = {}): LifecycleDeps & {
  repository: StateRepository & MemoryRepository;
  logger: MemoryLogger;
  availabilityChecks: string[];
  eligibilityChecks: string[];
} {
  const {
    prepared,
    selectorError,
    unavailableIds = [],
    ineligibleIds = [],
    availabilityErrorIds = [],
    eligibilityErrorIds = [],
    ...state
  } = options;
  const repository = new MemoryRepository(serviceState(state));
  const logger = new MemoryLogger();
  const availabilityChecks: string[] = [];
  const eligibilityChecks: string[] = [];
  const selector = {
    async prepare(input: ServiceState): Promise<ServiceState> {
      if (selectorError) throw selectorError;
      return structuredClone(prepared ?? input);
    },
  };
  const providers = {
    async isAvailable(photo: { photoId: string }): Promise<boolean> {
      availabilityChecks.push(photo.photoId);
      if (availabilityErrorIds.includes(photo.photoId)) {
        throw new Error(`availability check failed for ${photo.photoId}`);
      }
      return !unavailableIds.includes(photo.photoId);
    },
    async isEligible(photo: { photoId: string }): Promise<boolean> {
      eligibilityChecks.push(photo.photoId);
      if (eligibilityErrorIds.includes(photo.photoId)) {
        throw new Error(`eligibility check failed for ${photo.photoId}`);
      }
      return !ineligibleIds.includes(photo.photoId);
    },
  };

  return {
    repository: repository as StateRepository & MemoryRepository,
    selector: selector as unknown as SelectionEngine,
    providers,
    logger,
    availabilityChecks,
    eligibilityChecks,
  };
}

describe("runPreparation", () => {
  it("writes the complete state only after a successful next-day selection", async () => {
    const current = entry({ photoId: "current" });
    const prepared = serviceState({
      current,
      next: entry({ photoId: "tomorrow", intendedDate: "2026-08-27" }),
      reserve: [entry({ photoId: "reserve" })],
      lastPreparation: {
        at: "2026-08-26T23:45:00.000Z",
        status: "success",
        detail: "prepared tomorrow",
      },
    });
    const deps = lifecycleDeps({ current, prepared });

    await runPreparation(deps, PREPARATION_TIME);

    expect(deps.repository.writeCalls).toEqual([prepared]);
    expect(deps.logger.infos[0]).toMatchObject({
      event: "preparation_success",
      photoId: "tomorrow",
      score: 90,
      reserveDepth: 1,
    });
  });

  it("does not persist a failed selection result that prunes the reserve", async () => {
    const current = entry({ photoId: "current" });
    const reserve = [entry({ photoId: "reserve" })];
    const failed = serviceState({
      current,
      reserve: [],
      lastPreparation: {
        at: "2026-08-26T23:45:00.000Z",
        status: "failed",
        detail: "no passing candidate",
      },
    });
    const deps = lifecycleDeps({ current, reserve, prepared: failed });

    await runPreparation(deps, PREPARATION_TIME);

    expect(deps.repository.writeCalls).toHaveLength(0);
    expect(deps.logger.errors[0]).toMatchObject({
      event: "preparation_failed",
      reserveDepth: 1,
    });
  });

  it("does not overwrite state when preparation throws", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "current" }),
      reserve: [entry({ photoId: "reserve" })],
      selectorError: new Error("AI unavailable"),
    });

    await runPreparation(deps, PREPARATION_TIME);

    expect(deps.repository.writeCalls).toHaveLength(0);
    expect(deps.logger.errors[0]).toMatchObject({
      event: "preparation_failed",
      message: "AI unavailable",
      reserveDepth: 1,
    });
  });
});

describe("runPromotion", () => {
  it("promotes the prepared candidate for the current UTC date", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday", intendedDate: "2026-08-26" }),
      next: entry({ photoId: "today", intendedDate: "2026-08-27" }),
      reserve: [entry({ photoId: "reserve" })],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.availabilityChecks).toEqual(["today"]);
    expect(deps.eligibilityChecks).toEqual(["today"]);
    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "today",
      origin: "fresh",
      intendedDate: "2026-08-27",
    });
    expect(deps.repository.saved?.next).toBeUndefined();
    expect(deps.repository.saved?.recentPhotoIds).toEqual(["yesterday"]);
    expect(deps.repository.saved?.reserve.map((photo) => photo.photoId)).toEqual([
      "reserve",
    ]);
    expect(deps.logger.infos[0]).toMatchObject({
      event: "promotion_fresh",
      photoId: "today",
      score: 90,
      reserveDepth: 1,
    });
  });

  it.each([
    ["unavailable", { unavailableIds: ["today"] }],
    ["ineligible", { ineligibleIds: ["today"] }],
  ])("falls through to a reserve when the prepared candidate is definitively %s", async (_reason, providerState) => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday", intendedDate: "2026-08-26" }),
      next: entry({ photoId: "today", intendedDate: "2026-08-27" }),
      reserve: [entry({ photoId: "reserve" })],
      ...providerState,
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.availabilityChecks[0]).toBe("today");
    if (_reason === "ineligible") expect(deps.eligibilityChecks[0]).toBe("today");
    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "reserve",
      origin: "reserve",
    });
    expect(deps.repository.saved?.next).toBeUndefined();
    expect(deps.logger.infos).not.toContainEqual(
      expect.objectContaining({ event: "promotion_fresh", photoId: "today" }),
    );
  });

  it.each([
    ["availability", { availabilityErrorIds: ["today"] }],
    ["eligibility", { eligibilityErrorIds: ["today"] }],
  ])("retains the verified current image when prepared-candidate %s revalidation throws", async (check, providerState) => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday", intendedDate: "2026-08-26" }),
      next: entry({ photoId: "today", intendedDate: "2026-08-27" }),
      ...providerState,
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "yesterday",
      origin: "retained",
    });
    expect(deps.repository.saved?.next).toBeUndefined();
    expect(deps.logger.errors).toContainEqual(
      expect.objectContaining({
        event: "prepared_unavailable",
        photoId: "today",
        reason: `${check}_check_failed`,
        transient: true,
      }),
    );
    expect(deps.logger.infos).not.toContainEqual(
      expect.objectContaining({ event: "promotion_fresh", photoId: "today" }),
    );
  });

  it("uses the highest-scoring available reserve and removes the replaced current", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday", intendedDate: "2026-08-26" }),
      next: entry({ photoId: "stale-next", intendedDate: "2026-08-26" }),
      reserve: [
        entry({ photoId: "lower", quality: quality({ total: 85 }) }),
        entry({ photoId: "higher", quality: quality({ total: 95 }) }),
      ],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.availabilityChecks).toEqual(["higher"]);
    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "higher",
      origin: "reserve",
      intendedDate: "2026-08-27",
    });
    expect(deps.repository.saved?.reserve.map((photo) => photo.photoId)).toEqual([
      "lower",
    ]);
    expect(deps.repository.saved?.recentPhotoIds).toContain("yesterday");
    expect(deps.repository.saved?.reserve.map((photo) => photo.photoId)).not.toContain(
      "yesterday",
    );
  });

  it("drops unavailable reserve entries before promoting the next verified one", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday" }),
      reserve: [
        entry({ photoId: "gone", quality: quality({ total: 96 }) }),
        entry({ photoId: "available", quality: quality({ total: 88 }) }),
      ],
      unavailableIds: ["gone"],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.availabilityChecks).toEqual(["gone", "available"]);
    expect(deps.repository.saved?.current?.photoId).toBe("available");
    expect(deps.repository.saved?.reserve).toEqual([]);
    expect(deps.logger.errors[0]).toMatchObject({
      event: "reserve_unavailable",
      photoId: "gone",
      reserveDepth: 1,
    });
  });

  it("drops a reserve whose live provider metadata is no longer eligible", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday" }),
      reserve: [
        entry({ photoId: "license-changed", quality: quality({ total: 96 }) }),
        entry({ photoId: "eligible", quality: quality({ total: 88 }) }),
      ],
      ineligibleIds: ["license-changed"],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.availabilityChecks).toEqual(["license-changed", "eligible"]);
    expect(deps.eligibilityChecks).toEqual(["license-changed", "eligible"]);
    expect(deps.repository.saved?.current?.photoId).toBe("eligible");
    expect(deps.repository.saved?.reserve).toEqual([]);
    expect(deps.logger.errors[0]).toMatchObject({
      event: "reserve_unavailable",
      photoId: "license-changed",
      reason: "ineligible",
    });
  });

  it("preserves a reserve when its availability check fails transiently", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday" }),
      reserve: [
        entry({ photoId: "check-failed", quality: quality({ total: 96 }) }),
        entry({ photoId: "fallback", quality: quality({ total: 88 }) }),
      ],
      availabilityErrorIds: ["check-failed"],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.repository.saved?.current?.photoId).toBe("fallback");
    expect(deps.repository.saved?.reserve.map((photo) => photo.photoId)).toEqual([
      "check-failed",
    ]);
    expect(deps.logger.errors[0]).toMatchObject({
      event: "reserve_unavailable",
      photoId: "check-failed",
      transient: true,
    });
  });

  it("preserves the complete reserve when eligibility checks fail transiently", async () => {
    const reserve = [
      entry({ photoId: "first", quality: quality({ total: 96 }) }),
      entry({ photoId: "second", quality: quality({ total: 88 }) }),
    ];
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday" }),
      reserve,
      eligibilityErrorIds: ["first", "second"],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "yesterday",
      origin: "retained",
    });
    expect(deps.repository.saved?.reserve).toEqual(reserve);
    expect(deps.logger.errors).toHaveLength(2);
    expect(deps.logger.errors.every((event) => event.transient === true)).toBe(true);
  });

  it("retains yesterday when neither next nor reserve is valid", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday", intendedDate: "2026-08-26" }),
      reserve: [entry({ photoId: "gone" })],
      unavailableIds: ["gone"],
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.repository.saved?.current).toMatchObject({
      photoId: "yesterday",
      origin: "retained",
      intendedDate: "2026-08-27",
    });
    expect(deps.repository.saved?.reserve).toEqual([]);
    expect(deps.repository.saved?.recentPhotoIds).toEqual([]);
    expect(deps.logger.infos.at(-1)).toMatchObject({
      event: "promotion_retained",
      photoId: "yesterday",
      reserveDepth: 0,
    });
  });

  it("keeps only the 30 most recently replaced unique photo IDs", async () => {
    const history = Array.from({ length: 30 }, (_, index) => `old-${index}`);
    const deps = lifecycleDeps({
      current: entry({ photoId: "yesterday" }),
      next: entry({ photoId: "today", intendedDate: "2026-08-27" }),
      recentPhotoIds: history,
    });

    await runPromotion(deps, PROMOTION_TIME);

    expect(deps.repository.saved?.recentPhotoIds).toEqual([
      "yesterday",
      ...history.slice(0, 29),
    ]);
  });
});

describe("promoteAvailableReserve", () => {
  it("persists unavailable removal and the verified reserve promotion atomically", async () => {
    const deps = lifecycleDeps({
      current: entry({ photoId: "current" }),
      reserve: [
        entry({ photoId: "gone", quality: quality({ total: 92 }) }),
        entry({ photoId: "fallback", quality: quality({ total: 89 }) }),
      ],
      unavailableIds: ["gone"],
    });

    const promoted = await promoteAvailableReserve(
      deps as unknown as ReservePromotionDeps,
      PROMOTION_TIME,
    );

    expect(promoted).toMatchObject({ photoId: "fallback", origin: "reserve" });
    expect(deps.repository.writeCalls).toHaveLength(1);
    expect(deps.repository.saved?.current?.photoId).toBe("fallback");
    expect(deps.repository.saved?.reserve).toEqual([]);
  });

  it("does not double-promote when another request changes current during verification", async () => {
    const original = entry({ photoId: "current" });
    const concurrent = entry({
      photoId: "already-promoted",
      sourceUrl: "https://img/already-promoted.jpg",
      origin: "reserve",
    });
    const candidate = entry({
      photoId: "candidate",
      sourceUrl: "https://img/candidate.jpg",
    });
    const deps = lifecycleDeps({ current: original, reserve: [candidate] });
    let interleaved = false;
    deps.providers.isAvailable = async () => {
      if (!interleaved) {
        interleaved = true;
        await deps.repository.write(serviceState({ current: concurrent }));
      }
      return true;
    };

    const selected = await promoteAvailableReserveIfCurrent(
      deps,
      original.photoId,
      PROMOTION_TIME,
    );

    expect(selected?.photoId).toBe("already-promoted");
    expect(deps.repository.writeCalls).toHaveLength(1);
    expect(deps.repository.saved?.current?.photoId).toBe("already-promoted");
    expect(deps.logger.infos).not.toContainEqual(
      expect.objectContaining({ event: "promotion_reserve" }),
    );
  });
});
