import { describe, expect, it } from "vitest";

import type { OperationalLogger } from "../src/lifecycle";
import type {
  EligiblePhoto,
  QualityAssessment,
  ServiceState,
} from "../src/model";
import {
  ProviderTransientError,
  type PhotoProviderClient,
  type RankedCandidate,
  type SearchPass,
} from "../src/provider";
import { ProviderRegistry } from "../src/providers";
import { SelectionEngine } from "../src/selector";
import { eligiblePhoto, entry, quality, serviceState } from "./factories";

const PREPARE_TIME = Date.parse("2026-08-26T23:45:00.000Z");

function candidate(
  provider: "wordpress" | "commons",
  providerId: string,
  searchRank = 0,
): RankedCandidate {
  return {
    photo: eligiblePhoto({
      provider,
      providerId,
      photoId: `${provider}:${providerId}`,
      sourceUrl: `https://example.com/${provider}/${providerId}/source.jpg`,
      previewUrl: `https://example.com/${provider}/${providerId}/preview.jpg`,
    }),
    searchRank,
  };
}

function candidates(
  provider: "wordpress" | "commons",
  prefix: string,
  count: number,
): RankedCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    candidate(provider, `${prefix}-${index + 1}`, index),
  );
}

interface FakeProviderOptions {
  recent?: RankedCandidate[];
  all?: RankedCandidate[];
  transientPasses?: SearchPass[];
  unavailableIds?: string[];
  ineligibleIds?: string[];
  availabilityErrorIds?: string[];
  eligibilityErrorIds?: string[];
  searchLog?: string[];
}

class FakeProvider implements PhotoProviderClient {
  readonly searchCalls: SearchPass[] = [];
  readonly availabilityChecks: string[] = [];
  readonly eligibilityChecks: string[] = [];

  constructor(
    readonly provider: "wordpress" | "commons",
    private readonly options: FakeProviderOptions = {},
  ) {}

  async search(_nowMs: number, pass: SearchPass): Promise<RankedCandidate[]> {
    this.searchCalls.push(pass);
    this.options.searchLog?.push(`${this.provider}:${pass}`);
    if (this.options.transientPasses?.includes(pass)) {
      throw new ProviderTransientError(`${this.provider} ${pass} failed`);
    }
    return this.options[pass] ?? [];
  }

  async isAvailable(photo: EligiblePhoto): Promise<boolean> {
    this.availabilityChecks.push(photo.photoId);
    if (this.options.availabilityErrorIds?.includes(photo.photoId)) {
      throw new ProviderTransientError(`availability failed for ${photo.photoId}`);
    }
    return !this.options.unavailableIds?.includes(photo.photoId);
  }

  async isEligible(photo: EligiblePhoto): Promise<boolean> {
    this.eligibilityChecks.push(photo.photoId);
    if (this.options.eligibilityErrorIds?.includes(photo.photoId)) {
      throw new ProviderTransientError(`eligibility failed for ${photo.photoId}`);
    }
    return !this.options.ineligibleIds?.includes(photo.photoId);
  }
}

class FakeScorer {
  readonly seenIds: string[] = [];

  constructor(
    private readonly assessments: ReadonlyMap<
      string,
      QualityAssessment | number | null
    > = new Map(),
  ) {}

  async score(photo: EligiblePhoto): Promise<QualityAssessment | null> {
    this.seenIds.push(photo.photoId);
    const assessment = this.assessments.get(photo.photoId);
    if (assessment === null) return null;
    if (typeof assessment === "object") return assessment;
    const total = assessment ?? 90;
    return quality({ total, passed: total >= 82 });
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

function harness(options: {
  wordpress?: FakeProviderOptions;
  commons?: FakeProviderOptions;
  assessments?: ReadonlyMap<string, QualityAssessment | number | null>;
} = {}): {
  engine: SelectionEngine;
  wordpress: FakeProvider;
  commons: FakeProvider;
  scorer: FakeScorer;
  logger: MemoryLogger;
} {
  const wordpress = new FakeProvider("wordpress", options.wordpress);
  const commons = new FakeProvider("commons", options.commons);
  const scorer = new FakeScorer(options.assessments);
  const logger = new MemoryLogger();
  const providers = new ProviderRegistry([wordpress, commons]);
  return {
    engine: new SelectionEngine(providers, scorer, logger),
    wordpress,
    commons,
    scorer,
    logger,
  };
}

function providerEntry(
  provider: "wordpress" | "commons",
  providerId: string,
  total = 90,
) {
  return entry({
    provider,
    providerId,
    photoId: `${provider}:${providerId}`,
    sourceUrl: `https://example.com/${provider}/${providerId}/source.jpg`,
    previewUrl: `https://example.com/${provider}/${providerId}/preview.jpg`,
    quality: quality({ total, passed: total >= 82 }),
  });
}

function preparedIds(state: ServiceState): string[] {
  return [state.next, ...state.reserve]
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .map((value) => value.photoId);
}

describe("SelectionEngine.prepare", () => {
  it("fills the ready set from WordPress before searching Commons", async () => {
    const searchLog: string[] = [];
    const { engine, commons, scorer } = harness({
      wordpress: {
        recent: candidates("wordpress", "primary", 10),
        searchLog,
      },
      commons: {
        recent: candidates("commons", "fallback", 10),
        searchLog,
      },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(searchLog).toEqual(["wordpress:recent"]);
    expect(commons.searchCalls).toEqual([]);
    expect(scorer.seenIds).toHaveLength(10);
    expect(result.next?.provider).toBe("wordpress");
    expect(result.reserve).toHaveLength(9);
  });

  it("uses Commons only after WordPress recent and all searches cannot fill the ready set", async () => {
    const searchLog: string[] = [];
    const { engine, scorer } = harness({
      wordpress: {
        recent: candidates("wordpress", "primary", 2),
        all: [],
        searchLog,
      },
      commons: {
        recent: candidates("commons", "fallback", 8),
        searchLog,
      },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(searchLog).toEqual([
      "wordpress:recent",
      "wordpress:all",
      "commons:recent",
    ]);
    expect(scorer.seenIds).toHaveLength(10);
    expect(preparedIds(result)).toContain("commons:fallback-1");
  });

  it("shares one 20-preview budget across both providers and search passes", async () => {
    const wordpressCandidates = candidates("wordpress", "primary", 15);
    const commonsCandidates = candidates("commons", "fallback", 10);
    const assessments = new Map<string, number>(
      wordpressCandidates.map(({ photo }) => [photo.photoId, 81]),
    );
    const { engine, scorer } = harness({
      wordpress: { recent: wordpressCandidates, all: [] },
      commons: { recent: commonsCandidates },
      assessments,
    });

    await engine.prepare(serviceState(), PREPARE_TIME);

    expect(scorer.seenIds).toHaveLength(20);
    expect(scorer.seenIds.filter((id) => id.startsWith("commons:"))).toHaveLength(
      5,
    );
  });

  it("continues to Commons after transient WordPress search failures", async () => {
    const { engine, commons } = harness({
      wordpress: { transientPasses: ["recent", "all"] },
      commons: { recent: candidates("commons", "fallback", 10) },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(commons.searchCalls).toEqual(["recent"]);
    expect(result.next?.provider).toBe("commons");
    expect(result.lastPreparation?.status).toBe("success");
  });

  it("evaluates a duplicate global photo ID only once", async () => {
    const repeated = candidate("wordpress", "duplicate");
    const { engine, scorer } = harness({
      wordpress: { recent: [repeated, repeated], all: [repeated] },
    });

    await engine.prepare(serviceState(), PREPARE_TIME);

    expect(scorer.seenIds).toEqual(["wordpress:duplicate"]);
  });

  it("does not collide provider-local IDs from different providers", async () => {
    const { engine, scorer } = harness({
      wordpress: { recent: [candidate("wordpress", "same-local-id")] },
      commons: { recent: [candidate("commons", "same-local-id")] },
    });

    await engine.prepare(serviceState(), PREPARE_TIME);

    expect(scorer.seenIds).toEqual([
      "wordpress:same-local-id",
      "commons:same-local-id",
    ]);
  });

  it("scores only enough fresh passers to fill slots left by verified reserves", async () => {
    const reserve = Array.from({ length: 8 }, (_, index) =>
      providerEntry("wordpress", `reserve-${index + 1}`),
    );
    const { engine, commons, scorer } = harness({
      wordpress: { recent: candidates("wordpress", "fresh", 10) },
      commons: { recent: candidates("commons", "fallback", 10) },
    });

    const result = await engine.prepare(serviceState({ reserve }), PREPARE_TIME);

    expect(scorer.seenIds).toHaveLength(2);
    expect(commons.searchCalls).toEqual([]);
    expect(result.reserve).toHaveLength(9);
  });

  it("counts only source-unique reserves when deciding how many fresh passers are needed", async () => {
    const reserve = Array.from({ length: 9 }, (_, index) =>
      providerEntry("wordpress", `reserve-${index + 1}`),
    );
    reserve[8] = {
      ...reserve[8]!,
      sourceUrl: reserve[7]!.sourceUrl,
    };
    const { engine, scorer } = harness({
      wordpress: { recent: candidates("wordpress", "fresh", 10) },
    });

    const result = await engine.prepare(serviceState({ reserve }), PREPARE_TIME);

    expect(scorer.seenIds).toHaveLength(2);
    expect(result.reserve).toHaveLength(9);
    expect(new Set(result.reserve.map((photo) => photo.sourceUrl)).size).toBe(9);
  });

  it("does not count a reserve source that duplicates the current image", async () => {
    const current = providerEntry("wordpress", "current");
    const reserve = Array.from({ length: 9 }, (_, index) =>
      providerEntry("wordpress", `reserve-${index + 1}`),
    );
    reserve[8] = { ...reserve[8]!, sourceUrl: current.sourceUrl };
    const { engine, scorer } = harness({
      wordpress: { recent: candidates("wordpress", "fresh", 10) },
    });

    const result = await engine.prepare(
      serviceState({ current, reserve }),
      PREPARE_TIME,
    );

    expect(scorer.seenIds).toHaveLength(2);
    expect(result.reserve).toHaveLength(9);
    expect(result.reserve.map((photo) => photo.sourceUrl)).not.toContain(
      current.sourceUrl,
    );
  });

  it("excludes recent global IDs for both provider types", async () => {
    const { engine, scorer } = harness({
      wordpress: {
        recent: [
          candidate("wordpress", "recent"),
          candidate("wordpress", "fresh"),
        ],
      },
      commons: {
        recent: [
          candidate("commons", "recent"),
          candidate("commons", "fresh"),
        ],
      },
    });

    await engine.prepare(
      serviceState({
        recentPhotoIds: ["wordpress:recent", "commons:recent"],
      }),
      PREPARE_TIME,
    );

    expect(scorer.seenIds).toEqual(["wordpress:fresh", "commons:fresh"]);
  });

  it("uses search rank before provider priority when quality ties", async () => {
    const { engine } = harness({
      wordpress: { recent: [candidate("wordpress", "rank-one", 1)] },
      commons: { recent: [candidate("commons", "rank-zero", 0)] },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(result.next?.photoId).toBe("commons:rank-zero");
  });

  it("uses provider priority before the UTC hash when quality and search rank tie", async () => {
    const { engine } = harness({
      wordpress: { recent: [candidate("wordpress", "primary", 0)] },
      commons: { recent: [candidate("commons", "fallback", 0)] },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(result.next?.photoId).toBe("wordpress:primary");
  });

  it("uses the UTC-date hash after quality, rank, and provider priority tie", async () => {
    const { engine } = harness({
      wordpress: {
        recent: [
          candidate("wordpress", "tied-11", 0),
          candidate("wordpress", "tied-1", 0),
        ],
      },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(result.next?.photoId).toBe("wordpress:tied-1");
  });

  it("uses global photo ID after all other quality tie-breakers", async () => {
    const { engine } = harness({
      wordpress: {
        recent: [
          candidate("wordpress", "1gibdbd", 0),
          candidate("wordpress", "138c7lk", 0),
        ],
      },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(result.next?.photoId).toBe("wordpress:138c7lk");
  });

  it("dispatches reserve revalidation through each entry's provider", async () => {
    const { engine, wordpress, commons } = harness();
    const reserve = [
      providerEntry("wordpress", "primary-reserve"),
      providerEntry("commons", "fallback-reserve"),
    ];

    await engine.prepare(serviceState({ reserve }), PREPARE_TIME);

    expect(wordpress.availabilityChecks).toContain("wordpress:primary-reserve");
    expect(wordpress.eligibilityChecks).toContain("wordpress:primary-reserve");
    expect(commons.availabilityChecks).toContain("commons:fallback-reserve");
    expect(commons.eligibilityChecks).toContain("commons:fallback-reserve");
  });

  it("preserves transiently unverifiable reserves and removes definitive failures", async () => {
    const transient = providerEntry("wordpress", "transient");
    const unavailable = providerEntry("commons", "unavailable");
    const ineligible = providerEntry("commons", "ineligible");
    const { engine } = harness({
      wordpress: { availabilityErrorIds: [transient.photoId] },
      commons: {
        unavailableIds: [unavailable.photoId],
        ineligibleIds: [ineligible.photoId],
      },
    });

    const result = await engine.prepare(
      serviceState({ reserve: [transient, unavailable, ineligible] }),
      PREPARE_TIME,
    );

    expect(result.reserve).toEqual([transient]);
  });

  it("logs every valid AI decision with provider-neutral scores and no image bytes", async () => {
    const rejected = quality({
      total: 70,
      passed: false,
      hardRejects: ["soft focus"],
    });
    const assessments = new Map<string, QualityAssessment | null>([
      ["wordpress:accepted", quality()],
      ["wordpress:rejected", rejected],
      ["wordpress:invalid", null],
    ]);
    const { engine, logger } = harness({
      wordpress: {
        recent: [
          candidate("wordpress", "accepted"),
          candidate("wordpress", "rejected"),
          candidate("wordpress", "invalid"),
        ],
      },
      assessments,
    });

    await engine.prepare(serviceState(), PREPARE_TIME);

    const decisions = logger.infos.filter(
      (event) => event.event === "quality_decision",
    );
    expect(decisions).toHaveLength(2);
    expect(
      decisions.find((event) => event.photoId === "wordpress:accepted"),
    ).toMatchObject({
      event: "quality_decision",
      provider: "wordpress",
      photoId: "wordpress:accepted",
      technical: 27,
      subject: 28,
      composition: 18,
      landscape: 13,
      distractions: 4,
      components: {
        technical: 27,
        subject: 28,
        composition: 18,
        landscape: 13,
        distractions: 4,
      },
      total: 90,
      hardRejects: [],
      passed: true,
    });
    expect(
      decisions.find((event) => event.photoId === "wordpress:rejected"),
    ).toMatchObject({
      provider: "wordpress",
      photoId: "wordpress:rejected",
      total: 70,
      hardRejects: ["soft focus"],
      passed: false,
    });
    expect(logger.errors).toContainEqual(
      expect.objectContaining({
        event: "quality_invalid",
        provider: "wordpress",
        photoId: "wordpress:invalid",
      }),
    );
    expect(JSON.stringify([...logger.infos, ...logger.errors])).not.toContain(
      "/preview.jpg",
    );
    expect(JSON.stringify([...logger.infos, ...logger.errors])).not.toContain(
      "/source.jpg",
    );
  });

  it("preserves existing selection fields when no fresh candidate passes", async () => {
    const state = serviceState({
      current: providerEntry("wordpress", "current"),
      next: providerEntry("wordpress", "existing-next"),
      reserve: [providerEntry("commons", "reserve")],
    });
    const { engine } = harness({
      wordpress: { recent: [candidate("wordpress", "failing")] },
      assessments: new Map([["wordpress:failing", 81]]),
    });

    const result = await engine.prepare(state, PREPARE_TIME);

    expect(result.current).toEqual(state.current);
    expect(result.next).toEqual(state.next);
    expect(result.reserve).toEqual(state.reserve);
    expect(result.lastPreparation).toMatchObject({
      at: "2026-08-26T23:45:00.000Z",
      status: "failed",
    });
  });

  it("fails closed on a transient fresh availability check", async () => {
    const failed = candidate("wordpress", "check-error");
    const verified = candidate("wordpress", "verified");
    const { engine, scorer } = harness({
      wordpress: {
        recent: [failed, verified],
        availabilityErrorIds: [failed.photo.photoId],
      },
    });

    const result = await engine.prepare(serviceState(), PREPARE_TIME);

    expect(scorer.seenIds).toEqual(["wordpress:verified"]);
    expect(result.next?.photoId).toBe("wordpress:verified");
  });
});
