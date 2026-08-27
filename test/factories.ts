import type {
  EligiblePhoto,
  PhotoProviderName,
  QualityAssessment,
  SelectionEntry,
  ServiceState,
} from "../src/model";

export function eligiblePhoto(
  overrides: Partial<EligiblePhoto> = {},
): EligiblePhoto {
  const provider: PhotoProviderName = overrides.provider ?? "wordpress";
  const providerId = overrides.providerId ?? "234123";
  return {
    provider,
    providerId,
    photoId: overrides.photoId ?? `${provider}:${providerId}`,
    title: "Cattle in a pasture",
    photographer: "Ada Lovelace",
    photographerUrl: "https://example.com/photographers/ada",
    pageUrl: "https://example.com/photos/photo-1",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    sourceUrl: "https://example.com/photos/photo-1/source.jpg",
    previewUrl: "https://example.com/photos/photo-1/preview.jpg",
    width: 4032,
    height: 3024,
    ...overrides,
  };
}

export function quality(
  overrides: Partial<QualityAssessment> = {},
): QualityAssessment {
  return {
    technical: 27,
    subject: 28,
    composition: 18,
    landscape: 13,
    distractions: 4,
    total: 90,
    passed: true,
    hardRejects: [],
    reasons: ["Strong cattle landscape"],
    ...overrides,
  };
}

export function entry(overrides: Partial<SelectionEntry> = {}): SelectionEntry {
  const {
    quality: qualityOverride,
    scoredAt = "2026-08-26T00:00:00.000Z",
    intendedDate = "2026-08-26",
    origin = "fresh",
    ...photoOverrides
  } = overrides;
  return {
    ...eligiblePhoto(photoOverrides),
    quality: qualityOverride ?? quality(),
    scoredAt,
    intendedDate,
    origin,
  };
}

export function serviceState(
  overrides: Partial<ServiceState> = {},
): ServiceState {
  return {
    schemaVersion: 2,
    reserve: [],
    recentPhotoIds: [],
    ...overrides,
  };
}
