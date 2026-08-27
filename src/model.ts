export type AllowedLicense = "CC BY" | "CC BY-SA" | "CC0" | "Public Domain";
export type SelectionOrigin = "fresh" | "reserve" | "retained";
export type PhotoProviderName = "wordpress" | "commons";

export interface EligiblePhoto {
  provider: PhotoProviderName;
  providerId: string;
  photoId: string;
  title: string;
  photographer?: string;
  photographerUrl?: string;
  pageUrl: string;
  license: AllowedLicense;
  licenseUrl: string;
  sourceUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface QualityAssessment {
  technical: number;
  subject: number;
  composition: number;
  landscape: number;
  distractions: number;
  total: number;
  passed: boolean;
  hardRejects: string[];
  reasons: string[];
}

export interface SelectionEntry extends EligiblePhoto {
  quality: QualityAssessment;
  scoredAt: string;
  intendedDate: string;
  origin: SelectionOrigin;
}

export interface RunOutcome {
  at: string;
  status: "success" | "fallback" | "failed";
  detail: string;
}

export interface ServiceState {
  schemaVersion: 2;
  current?: SelectionEntry;
  next?: SelectionEntry;
  reserve: SelectionEntry[];
  recentPhotoIds: string[];
  lastPreparation?: RunOutcome;
  lastPromotion?: RunOutcome;
}

export interface AppEnv {
  STATE: KVNamespace;
  AI: Ai;
}
