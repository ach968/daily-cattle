import {
  MAX_DAILY_EVALUATIONS,
  MAX_RESERVES,
  QUALITY_THRESHOLD,
} from "./config";
import { nextUtcDate, utcDate } from "./day";
import type { OperationalLogger } from "./lifecycle";
import type { SelectionEntry, ServiceState } from "./model";
import {
  globalPhotoId,
  ProviderTransientError,
  type RankedCandidate,
  type SearchPass,
} from "./provider";
import type { ProviderRegistry } from "./providers";
import type { QualityScorer } from "./quality";

interface ScoredCandidate {
  entry: SelectionEntry;
  searchRank: number;
  providerPriority: number;
}

function deterministicRank(date: string, photoId: string): number {
  let hash = 2_166_136_261;
  for (const character of `${date}:${photoId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

function bySearchRank(date: string) {
  return (left: RankedCandidate, right: RankedCandidate): number =>
    left.searchRank - right.searchRank ||
    deterministicRank(date, left.photo.photoId) -
      deterministicRank(date, right.photo.photoId) ||
    left.photo.photoId.localeCompare(right.photo.photoId);
}

function byFreshQuality(date: string) {
  return (left: ScoredCandidate, right: ScoredCandidate): number =>
    right.entry.quality.total - left.entry.quality.total ||
    left.searchRank - right.searchRank ||
    left.providerPriority - right.providerPriority ||
    deterministicRank(date, left.entry.photoId) -
      deterministicRank(date, right.entry.photoId) ||
    left.entry.photoId.localeCompare(right.entry.photoId);
}

function byStoredQuality(date: string) {
  return (left: SelectionEntry, right: SelectionEntry): number =>
    right.quality.total - left.quality.total ||
    deterministicRank(date, left.photoId) -
      deterministicRank(date, right.photoId) ||
    left.photoId.localeCompare(right.photoId);
}

function passing(entry: SelectionEntry): boolean {
  return (
    entry.quality.passed &&
    entry.quality.total >= QUALITY_THRESHOLD &&
    entry.quality.hardRejects.length === 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function availableReserve(
  providers: Pick<ProviderRegistry, "isAvailable" | "isEligible">,
  reserve: SelectionEntry[],
): Promise<SelectionEntry[]> {
  const checks = await Promise.all(
    reserve.map(async (entry) => {
      if (!passing(entry)) return { entry, available: false };
      try {
        if (!(await providers.isAvailable(entry))) {
          return { entry, available: false };
        }
        return { entry, available: await providers.isEligible(entry) };
      } catch {
        return { entry, available: true };
      }
    }),
  );
  return checks.filter((check) => check.available).map((check) => check.entry);
}

function uniqueEntries(
  entries: SelectionEntry[],
  excludedIds: ReadonlySet<string> = new Set(),
  excludedSourceUrls: ReadonlySet<string> = new Set(),
): SelectionEntry[] {
  const unique = new Map<string, SelectionEntry>();
  const sourceUrls = new Set(excludedSourceUrls);
  for (const entry of entries) {
    if (
      !excludedIds.has(entry.photoId) &&
      !unique.has(entry.photoId) &&
      !sourceUrls.has(entry.sourceUrl)
    ) {
      unique.set(entry.photoId, entry);
      sourceUrls.add(entry.sourceUrl);
    }
  }
  return [...unique.values()];
}

function mergeReserves(
  fresh: SelectionEntry[],
  stored: SelectionEntry[],
  preparationDate: string,
): SelectionEntry[] {
  const freshQueue = uniqueEntries(fresh);
  const storedQueue = uniqueEntries(stored).sort(byStoredQuality(preparationDate));
  const merged: SelectionEntry[] = [];
  let freshIndex = 0;
  let storedIndex = 0;

  while (
    merged.length < MAX_RESERVES &&
    (freshIndex < freshQueue.length || storedIndex < storedQueue.length)
  ) {
    const nextFresh = freshQueue[freshIndex];
    const nextStored = storedQueue[storedIndex];
    if (
      nextFresh &&
      (!nextStored || nextFresh.quality.total > nextStored.quality.total)
    ) {
      merged.push(nextFresh);
      freshIndex += 1;
    } else if (nextStored) {
      merged.push(nextStored);
      storedIndex += 1;
    }
  }

  return merged;
}

export class SelectionEngine {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly scorer: Pick<QualityScorer, "score">,
    private readonly logger: OperationalLogger,
  ) {}

  async prepare(state: ServiceState, nowMs: number): Promise<ServiceState> {
    const timestamp = new Date(nowMs).toISOString();
    const preparationDate = utcDate(nowMs);
    const intendedDate = nextUtcDate(nowMs);
    const revalidatedReserve = await availableReserve(
      this.providers,
      state.reserve,
    );
    const protectedEntries = [state.current, state.next].filter(
      (entry): entry is SelectionEntry => entry !== undefined,
    );
    const validReserve = uniqueEntries(
      revalidatedReserve,
      new Set(protectedEntries.map((entry) => entry.photoId)),
      new Set(protectedEntries.map((entry) => entry.sourceUrl)),
    );
    const existingEntries = [state.current, state.next, ...state.reserve].filter(
      (entry): entry is SelectionEntry => entry !== undefined,
    );
    const excludedIds = new Set([
      ...existingEntries.map((entry) => entry.photoId),
      ...state.recentPhotoIds,
    ]);
    const excludedSourceUrls = new Set(
      existingEntries.map((entry) => entry.sourceUrl),
    );
    const evaluatedIds = new Set<string>();
    const evaluatedSourceUrls = new Set<string>();
    const passers: ScoredCandidate[] = [];
    const requiredFreshPassers = 1 + Math.max(0, MAX_RESERVES - validReserve.length);
    let evaluationCount = 0;

    for (const [providerPriority, provider] of this.providers.providers.entries()) {
      for (const pass of ["recent", "all"] satisfies SearchPass[]) {
        if (
          passers.length >= requiredFreshPassers ||
          evaluationCount >= MAX_DAILY_EVALUATIONS
        ) {
          break;
        }

        let candidates: RankedCandidate[];
        try {
          candidates = await provider.search(nowMs, pass);
        } catch (error: unknown) {
          this.logger.error({
            event: "provider_search_failed",
            at: timestamp,
            provider: provider.provider,
            pass,
            transient: error instanceof ProviderTransientError,
            message: errorMessage(error),
          });
          continue;
        }

        const ordered = [...candidates].sort(bySearchRank(preparationDate));
        for (const candidate of ordered) {
          if (
            passers.length >= requiredFreshPassers ||
            evaluationCount >= MAX_DAILY_EVALUATIONS
          ) {
            break;
          }

          const photo = candidate.photo;
          if (
            photo.provider !== provider.provider ||
            photo.photoId !== globalPhotoId(photo.provider, photo.providerId) ||
            excludedIds.has(photo.photoId) ||
            excludedSourceUrls.has(photo.sourceUrl) ||
            evaluatedIds.has(photo.photoId) ||
            evaluatedSourceUrls.has(photo.sourceUrl)
          ) {
            continue;
          }
          evaluatedIds.add(photo.photoId);
          evaluatedSourceUrls.add(photo.sourceUrl);

          try {
            if (!(await provider.isAvailable(photo))) continue;
          } catch {
            continue;
          }

          evaluationCount += 1;
          const assessment = await this.scorer.score(photo);
          if (!assessment) {
            this.logger.error({
              event: "quality_invalid",
              at: timestamp,
              provider: photo.provider,
              photoId: photo.photoId,
            });
            continue;
          }

          const entry: SelectionEntry = {
            ...photo,
            quality: assessment,
            scoredAt: timestamp,
            intendedDate,
            origin: "fresh",
          };
          const passed = passing(entry);
          this.logger.info({
            event: "quality_decision",
            at: timestamp,
            provider: photo.provider,
            photoId: photo.photoId,
            technical: assessment.technical,
            subject: assessment.subject,
            composition: assessment.composition,
            landscape: assessment.landscape,
            distractions: assessment.distractions,
            components: {
              technical: assessment.technical,
              subject: assessment.subject,
              composition: assessment.composition,
              landscape: assessment.landscape,
              distractions: assessment.distractions,
            },
            total: assessment.total,
            hardRejects: assessment.hardRejects,
            passed,
          });
          if (passed) {
            passers.push({ entry, searchRank: candidate.searchRank, providerPriority });
          }
        }
      }
    }

    if (passers.length === 0) {
      return {
        ...state,
        reserve: validReserve,
        lastPreparation: {
          at: timestamp,
          status: "failed",
          detail: `no passing candidate after ${evaluationCount} evaluations`,
        },
      };
    }

    passers.sort(byFreshQuality(preparationDate));
    const [nextCandidate, ...remainingPassers] = passers;
    const next = nextCandidate!.entry;
    const reserve = mergeReserves(
      remainingPassers.map((candidate) => candidate.entry),
      validReserve.filter((entry) => entry.photoId !== next.photoId),
      preparationDate,
    );

    return {
      ...state,
      next,
      reserve,
      lastPreparation: {
        at: timestamp,
        status: "success",
        detail: `prepared ${next.photoId} with ${reserve.length} reserves after ${evaluationCount} evaluations`,
      },
    };
  }
}
