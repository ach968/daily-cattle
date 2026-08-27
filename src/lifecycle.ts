import { MAX_RECENT_IDS } from "./config";
import { utcDate } from "./day";
import type { RunOutcome, SelectionEntry, ServiceState } from "./model";
import type { ProviderRegistry } from "./providers";
import type { SelectionEngine } from "./selector";
import type { StateRepository } from "./state";

const ONE_DAY_MS = 86_400_000;

export interface OperationalLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface LifecycleDeps {
  repository: StateRepository;
  providers: Pick<ProviderRegistry, "isAvailable" | "isEligible">;
  selector: SelectionEngine;
  logger: OperationalLogger;
}

export type ReservePromotionDeps = Pick<
  LifecycleDeps,
  "repository" | "providers" | "logger"
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function outcome(
  nowMs: number,
  status: RunOutcome["status"],
  detail: string,
): RunOutcome {
  return { at: new Date(nowMs).toISOString(), status, detail };
}

function recentWithReplaced(
  recentPhotoIds: string[],
  replaced: SelectionEntry | undefined,
  replacementId: string,
): string[] {
  if (!replaced || replaced.photoId === replacementId) return recentPhotoIds;
  return [
    replaced.photoId,
    ...recentPhotoIds.filter((photoId) => photoId !== replaced.photoId),
  ].slice(0, MAX_RECENT_IDS);
}

function withoutPhotos(
  reserve: SelectionEntry[],
  excludedIds: ReadonlySet<string>,
): SelectionEntry[] {
  return reserve.filter((entry) => !excludedIds.has(entry.photoId));
}

function nextAfterToday(
  next: SelectionEntry | undefined,
  today: string,
): SelectionEntry | undefined {
  return next && next.intendedDate > today ? next : undefined;
}

export const consoleLogger: OperationalLogger = {
  info(event): void {
    console.log(JSON.stringify(event));
  },
  error(event): void {
    console.error(JSON.stringify(event));
  },
};

export async function runPreparation(
  deps: LifecycleDeps,
  nowMs: number,
): Promise<void> {
  let state: ServiceState | undefined;
  try {
    state = await deps.repository.read();
    const prepared = await deps.selector.prepare(state, nowMs);
    const expectedDate = utcDate(nowMs + ONE_DAY_MS);
    if (
      prepared.lastPreparation?.status !== "success" ||
      prepared.next?.intendedDate !== expectedDate
    ) {
      deps.logger.error({
        event: "preparation_failed",
        at: new Date(nowMs).toISOString(),
        message: prepared.lastPreparation?.detail ?? "no valid next-day selection",
        currentPhotoId: state.current?.photoId,
        reserveDepth: state.reserve.length,
      });
      return;
    }

    await deps.repository.write(prepared);
    deps.logger.info({
      event: "preparation_success",
      at: new Date(nowMs).toISOString(),
      photoId: prepared.next.photoId,
      score: prepared.next.quality.total,
      previousReserveDepth: state.reserve.length,
      reserveDepth: prepared.reserve.length,
    });
  } catch (error: unknown) {
    deps.logger.error({
      event: "preparation_failed",
      at: new Date(nowMs).toISOString(),
      message: errorMessage(error),
      currentPhotoId: state?.current?.photoId,
      reserveDepth: state?.reserve.length ?? 0,
    });
  }
}

export async function promoteAvailableReserve(
  deps: ReservePromotionDeps,
  nowMs: number,
): Promise<SelectionEntry | null> {
  return promoteAvailableReserveInternal(deps, nowMs);
}

export async function promoteAvailableReserveIfCurrent(
  deps: ReservePromotionDeps,
  failedCurrentPhotoId: string,
  nowMs: number,
): Promise<SelectionEntry | null> {
  return promoteAvailableReserveInternal(deps, nowMs, failedCurrentPhotoId);
}

async function promoteAvailableReserveInternal(
  deps: ReservePromotionDeps,
  nowMs: number,
  failedCurrentPhotoId?: string,
): Promise<SelectionEntry | null> {
  const state = await deps.repository.read();
  if (
    failedCurrentPhotoId !== undefined &&
    state.current?.photoId !== failedCurrentPhotoId
  ) {
    return state.current ?? null;
  }
  const today = utcDate(nowMs);
  const ordered = [...state.reserve].sort(
    (left, right) => right.quality.total - left.quality.total,
  );
  const unavailableIds = new Set<string>();

  for (const candidate of ordered) {
    let available: boolean;
    try {
      available = await deps.providers.isAvailable(candidate);
    } catch (error: unknown) {
      deps.logger.error({
        event: "reserve_unavailable",
        at: new Date(nowMs).toISOString(),
        photoId: candidate.photoId,
        score: candidate.quality.total,
        reserveDepth: Math.max(0, state.reserve.length - unavailableIds.size),
        reason: "availability_check_failed",
        transient: true,
        message: errorMessage(error),
      });
      continue;
    }

    if (!available) {
      unavailableIds.add(candidate.photoId);
      deps.logger.error({
        event: "reserve_unavailable",
        at: new Date(nowMs).toISOString(),
        photoId: candidate.photoId,
        score: candidate.quality.total,
        reserveDepth: Math.max(0, state.reserve.length - unavailableIds.size),
        reason: "unavailable",
        transient: false,
      });
      continue;
    }

    let eligible: boolean;
    try {
      eligible = await deps.providers.isEligible(candidate);
    } catch (error: unknown) {
      deps.logger.error({
        event: "reserve_unavailable",
        at: new Date(nowMs).toISOString(),
        photoId: candidate.photoId,
        score: candidate.quality.total,
        reserveDepth: Math.max(0, state.reserve.length - unavailableIds.size),
        reason: "eligibility_check_failed",
        transient: true,
        message: errorMessage(error),
      });
      continue;
    }

    if (!eligible) {
      unavailableIds.add(candidate.photoId);
      deps.logger.error({
        event: "reserve_unavailable",
        at: new Date(nowMs).toISOString(),
        photoId: candidate.photoId,
        score: candidate.quality.total,
        reserveDepth: Math.max(0, state.reserve.length - unavailableIds.size),
        reason: "ineligible",
        transient: false,
      });
      continue;
    }

    let saveState = state;
    if (failedCurrentPhotoId !== undefined) {
      saveState = await deps.repository.read();
      if (saveState.current?.photoId !== failedCurrentPhotoId) {
        return saveState.current ?? null;
      }
      if (!saveState.reserve.some((entry) => entry.photoId === candidate.photoId)) {
        return null;
      }
    }

    const promoted: SelectionEntry = {
      ...candidate,
      intendedDate: today,
      origin: "reserve",
    };
    const excludedIds = new Set(unavailableIds);
    excludedIds.add(candidate.photoId);
    if (saveState.current) excludedIds.add(saveState.current.photoId);
    const reserve = withoutPhotos(saveState.reserve, excludedIds);
    const saved: ServiceState = {
      ...saveState,
      current: promoted,
      next: nextAfterToday(saveState.next, today),
      reserve,
      recentPhotoIds: recentWithReplaced(
        saveState.recentPhotoIds,
        saveState.current,
        promoted.photoId,
      ),
      lastPromotion: outcome(
        nowMs,
        "fallback",
        `promoted reserve ${promoted.photoId}`,
      ),
    };
    await deps.repository.write(saved);
    deps.logger.info({
      event: "promotion_reserve",
      at: new Date(nowMs).toISOString(),
      photoId: promoted.photoId,
      score: promoted.quality.total,
      reserveDepth: reserve.length,
      removedUnavailableCount: unavailableIds.size,
    });
    return promoted;
  }

  if (unavailableIds.size > 0) {
    let saveState = state;
    if (failedCurrentPhotoId !== undefined) {
      saveState = await deps.repository.read();
      if (saveState.current?.photoId !== failedCurrentPhotoId) {
        return saveState.current ?? null;
      }
    }
    await deps.repository.write({
      ...saveState,
      reserve: withoutPhotos(saveState.reserve, unavailableIds),
    });
  }
  return null;
}

async function preparedCandidateIsValid(
  deps: LifecycleDeps,
  candidate: SelectionEntry,
  nowMs: number,
): Promise<boolean> {
  let available: boolean;
  try {
    available = await deps.providers.isAvailable(candidate);
  } catch (error: unknown) {
    deps.logger.error({
      event: "prepared_unavailable",
      at: new Date(nowMs).toISOString(),
      photoId: candidate.photoId,
      reason: "availability_check_failed",
      transient: true,
      message: errorMessage(error),
    });
    return false;
  }
  if (!available) {
    deps.logger.error({
      event: "prepared_unavailable",
      at: new Date(nowMs).toISOString(),
      photoId: candidate.photoId,
      reason: "unavailable",
      transient: false,
    });
    return false;
  }

  let eligible: boolean;
  try {
    eligible = await deps.providers.isEligible(candidate);
  } catch (error: unknown) {
    deps.logger.error({
      event: "prepared_unavailable",
      at: new Date(nowMs).toISOString(),
      photoId: candidate.photoId,
      reason: "eligibility_check_failed",
      transient: true,
      message: errorMessage(error),
    });
    return false;
  }
  if (!eligible) {
    deps.logger.error({
      event: "prepared_unavailable",
      at: new Date(nowMs).toISOString(),
      photoId: candidate.photoId,
      reason: "ineligible",
      transient: false,
    });
    return false;
  }
  return true;
}

export async function runPromotion(
  deps: LifecycleDeps,
  nowMs: number,
): Promise<void> {
  const state = await deps.repository.read();
  const today = utcDate(nowMs);

  if (
    state.next?.intendedDate === today &&
    await preparedCandidateIsValid(deps, state.next, nowMs)
  ) {
    const promoted: SelectionEntry = {
      ...state.next,
      intendedDate: today,
      origin: "fresh",
    };
    const excludedIds = new Set([promoted.photoId]);
    if (state.current) excludedIds.add(state.current.photoId);
    const reserve = withoutPhotos(state.reserve, excludedIds);
    await deps.repository.write({
      ...state,
      current: promoted,
      next: undefined,
      reserve,
      recentPhotoIds: recentWithReplaced(
        state.recentPhotoIds,
        state.current,
        promoted.photoId,
      ),
      lastPromotion: outcome(nowMs, "success", `promoted fresh ${promoted.photoId}`),
    });
    deps.logger.info({
      event: "promotion_fresh",
      at: new Date(nowMs).toISOString(),
      photoId: promoted.photoId,
      score: promoted.quality.total,
      reserveDepth: reserve.length,
    });
    return;
  }

  if (await promoteAvailableReserve(deps, nowMs)) return;

  const fallbackState = await deps.repository.read();
  const reserve = fallbackState.reserve.filter(
    (entry) => entry.photoId !== fallbackState.current?.photoId,
  );
  if (!fallbackState.current) {
    await deps.repository.write({
      ...fallbackState,
      next: nextAfterToday(fallbackState.next, today),
      reserve,
      lastPromotion: outcome(nowMs, "failed", "no verified image available"),
    });
    deps.logger.error({
      event: "promotion_retained",
      at: new Date(nowMs).toISOString(),
      photoId: null,
      score: null,
      reserveDepth: reserve.length,
      message: "no verified current image to retain",
    });
    return;
  }

  const retained: SelectionEntry = {
    ...fallbackState.current,
    intendedDate: today,
    origin: "retained",
  };
  await deps.repository.write({
    ...fallbackState,
    current: retained,
    next: nextAfterToday(fallbackState.next, today),
    reserve,
    lastPromotion: outcome(nowMs, "fallback", `retained ${retained.photoId}`),
  });
  deps.logger.info({
    event: "promotion_retained",
    at: new Date(nowMs).toISOString(),
    photoId: retained.photoId,
    score: retained.quality.total,
    reserveDepth: reserve.length,
  });
}
