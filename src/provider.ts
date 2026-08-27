import type { EligiblePhoto, PhotoProviderName } from "./model";

export type SearchPass = "recent" | "all";

export interface RankedCandidate {
  photo: EligiblePhoto;
  searchRank: number;
}

export interface PhotoProviderClient {
  readonly provider: PhotoProviderName;
  search(nowMs: number, pass: SearchPass): Promise<RankedCandidate[]>;
  isAvailable(photo: EligiblePhoto): Promise<boolean>;
  isEligible(photo: EligiblePhoto): Promise<boolean>;
}

export class ProviderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransientError";
  }
}

export function globalPhotoId(
  provider: PhotoProviderName,
  providerId: string,
): string {
  return `${provider}:${providerId}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isImageResponse(response: Response): boolean {
  return (
    response.ok &&
    (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("image/")
  );
}

async function sourceCheck(
  fetcher: typeof fetch,
  sourceUrl: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetcher(sourceUrl, init);
  } catch {
    throw new ProviderTransientError(`${operation} failed`);
  }
}

function checkResponse(response: Response, operation: string): boolean {
  if (isTransientStatus(response.status)) {
    throw new ProviderTransientError(
      `${operation} temporarily failed with HTTP ${response.status}`,
    );
  }
  return isImageResponse(response);
}

export async function checkSourceAvailability(
  fetcher: typeof fetch,
  photo: EligiblePhoto,
): Promise<boolean> {
  const head = await sourceCheck(
    fetcher,
    photo.sourceUrl,
    { method: "HEAD" },
    "source availability check",
  );
  if (head.status !== 405 && head.status !== 501) {
    return checkResponse(head, "source availability check");
  }

  const range = await sourceCheck(
    fetcher,
    photo.sourceUrl,
    { method: "GET", headers: { Range: "bytes=0-0" } },
    "source range check",
  );
  return checkResponse(range, "source range check");
}
