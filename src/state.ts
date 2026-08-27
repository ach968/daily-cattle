import {
  MAX_RECENT_IDS,
  MAX_RESERVES,
  QUALITY_THRESHOLD,
  STATE_KEY,
} from "./config";
import { globalPhotoId } from "./provider";
import type {
  QualityAssessment,
  RunOutcome,
  SelectionEntry,
  ServiceState,
} from "./model";

function emptyState(): ServiceState {
  return {
    schemaVersion: 2,
    reserve: [],
    recentPhotoIds: [],
  };
}

const STATE_FIELDS = new Set([
  "schemaVersion",
  "current",
  "next",
  "reserve",
  "recentPhotoIds",
  "lastPreparation",
  "lastPromotion",
]);
const ENTRY_FIELDS = new Set([
  "provider",
  "providerId",
  "photoId",
  "title",
  "photographer",
  "photographerUrl",
  "pageUrl",
  "license",
  "licenseUrl",
  "sourceUrl",
  "previewUrl",
  "width",
  "height",
  "quality",
  "scoredAt",
  "intendedDate",
  "origin",
]);
const QUALITY_FIELDS = new Set([
  "technical",
  "subject",
  "composition",
  "landscape",
  "distractions",
  "total",
  "passed",
  "hardRejects",
  "reasons",
]);
const OUTCOME_FIELDS = new Set(["at", "status", "detail"]);
const LICENSES = new Set(["CC BY", "CC BY-SA", "CC0", "Public Domain"]);
const PROVIDERS = new Set(["wordpress", "commons"]);
const ORIGINS = new Set(["fresh", "reserve", "retained"]);
const OUTCOME_STATUSES = new Set(["success", "fallback", "failed"]);
const QUALITY_COMPONENT_BOUNDS = {
  technical: 30,
  subject: 30,
  composition: 20,
  landscape: 15,
  distractions: 5,
} as const;

interface StateKv {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(record: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(record).every((field) => fields.has(field));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isTimestamp(value: unknown): value is string {
  if (
    !isString(value) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isUtcDate(value: unknown): value is string {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isQuality(value: unknown): value is QualityAssessment {
  if (!isRecord(value) || !hasOnlyFields(value, QUALITY_FIELDS)) return false;
  for (const [component, maximum] of Object.entries(QUALITY_COMPONENT_BOUNDS)) {
    if (!isBoundedInteger(value[component], maximum)) return false;
  }
  if (!isStringArray(value.hardRejects) || !isStringArray(value.reasons)) return false;

  const total =
    (value.technical as number) +
    (value.subject as number) +
    (value.composition as number) +
    (value.landscape as number) +
    (value.distractions as number);
  const passed = total >= QUALITY_THRESHOLD && value.hardRejects.length === 0;
  return value.total === total && value.passed === passed;
}

function entryValidationProblem(value: unknown): string | null {
  if (!isRecord(value) || !hasOnlyFields(value, ENTRY_FIELDS)) {
    return "entry is invalid";
  }
  if (
    !PROVIDERS.has(value.provider as string) ||
    !isNonEmptyString(value.providerId) ||
    !isNonEmptyString(value.photoId)
  ) {
    return "entry provider identity is invalid";
  }
  if (value.photoId !== globalPhotoId(value.provider as never, value.providerId)) {
    return "selection provider ID does not match its global photo ID";
  }
  if (
    !isString(value.title) ||
    !(value.photographer === undefined || isNonEmptyString(value.photographer)) ||
    !(value.photographerUrl === undefined || isHttpUrl(value.photographerUrl)) ||
    !isNonEmptyString(value.pageUrl) ||
    !LICENSES.has(value.license as string) ||
    !isNonEmptyString(value.licenseUrl) ||
    !isNonEmptyString(value.sourceUrl) ||
    !isNonEmptyString(value.previewUrl) ||
    !Number.isInteger(value.width) ||
    (value.width as number) < 1920 ||
    !Number.isInteger(value.height) ||
    (value.height as number) < 1080 ||
    (value.width as number) <= (value.height as number) ||
    !isQuality(value.quality) ||
    !isTimestamp(value.scoredAt) ||
    !isUtcDate(value.intendedDate) ||
    !ORIGINS.has(value.origin as string)
  ) {
    return "entry is invalid";
  }
  return null;
}

function isEntry(value: unknown): value is SelectionEntry {
  return entryValidationProblem(value) === null;
}

function isOutcome(value: unknown): value is RunOutcome {
  return (
    isRecord(value) &&
    hasOnlyFields(value, OUTCOME_FIELDS) &&
    isTimestamp(value.at) &&
    OUTCOME_STATUSES.has(value.status as string) &&
    isString(value.detail)
  );
}

function invalid(message: string): never {
  throw new StateValidationError(message);
}

export function parseServiceState(value: unknown): ServiceState {
  if (!isRecord(value) || !hasOnlyFields(value, STATE_FIELDS)) {
    return invalid("state must be an object with known fields");
  }
  if (value.schemaVersion !== 2) return invalid("unsupported state schema version");
  if (!Array.isArray(value.reserve) || value.reserve.length > MAX_RESERVES) {
    return invalid("reserve must contain at most nine entries");
  }
  const entryProblems = [
    ...(value.current === undefined ? [] : [entryValidationProblem(value.current)]),
    ...(value.next === undefined ? [] : [entryValidationProblem(value.next)]),
    ...value.reserve.map(entryValidationProblem),
  ];
  if (entryProblems.includes("selection provider ID does not match its global photo ID")) {
    return invalid("selection provider ID does not match its global photo ID");
  }
  if (!value.reserve.every(isEntry)) return invalid("reserve contains an invalid entry");
  if (
    !isStringArray(value.recentPhotoIds) ||
    value.recentPhotoIds.length > MAX_RECENT_IDS ||
    value.recentPhotoIds.some((id) => id.length === 0) ||
    new Set(value.recentPhotoIds).size !== value.recentPhotoIds.length
  ) {
    return invalid("recent photo history is invalid");
  }
  if (value.current !== undefined && !isEntry(value.current)) {
    return invalid("current selection is invalid");
  }
  if (value.next !== undefined && !isEntry(value.next)) {
    return invalid("next selection is invalid");
  }
  if (value.lastPreparation !== undefined && !isOutcome(value.lastPreparation)) {
    return invalid("last preparation outcome is invalid");
  }
  if (value.lastPromotion !== undefined && !isOutcome(value.lastPromotion)) {
    return invalid("last promotion outcome is invalid");
  }

  const selectionIds = [
    ...(isEntry(value.current) ? [value.current.photoId] : []),
    ...(isEntry(value.next) ? [value.next.photoId] : []),
    ...value.reserve.map((entry) => entry.photoId),
  ];
  if (new Set(selectionIds).size !== selectionIds.length) {
    return invalid("current, next, and reserve photo IDs must be unique");
  }

  return value as unknown as ServiceState;
}

export class StateRepository {
  constructor(private readonly kv: StateKv) {}

  async read(): Promise<ServiceState> {
    const persisted = await this.kv.get(STATE_KEY, "text");
    if (persisted === null) return emptyState();

    let decoded: unknown;
    try {
      decoded = JSON.parse(persisted) as unknown;
    } catch {
      throw new StateValidationError("persisted state is not valid JSON");
    }
    return parseServiceState(decoded);
  }

  async write(state: ServiceState): Promise<void> {
    const validated = parseServiceState(state);
    await this.kv.put(STATE_KEY, JSON.stringify(validated));
  }
}
