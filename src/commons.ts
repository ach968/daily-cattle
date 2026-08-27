import { COMMONS_ENDPOINT, OUTBOUND_USER_AGENT, PROVIDER_SEARCH_TERMS } from "./config";
import type { OperationalLogger } from "./lifecycle";
import type { AllowedLicense, EligiblePhoto } from "./model";
import {
  checkSourceAvailability,
  globalPhotoId,
  ProviderTransientError,
  type PhotoProviderClient,
  type RankedCandidate,
  type SearchPass,
} from "./provider";

const MIN_WIDTH = 1920;
const MIN_HEIGHT = 1080;
const MAX_ATTEMPTS = 3;
const MAX_SEARCH_PAGES_PER_QUERY = 3;
const METADATA_CACHE_TTL_MS = 60_000;
const COMMONS_PAGE_HOST = "commons.wikimedia.org";
const COMMONS_MEDIA_HOST = "upload.wikimedia.org";
const LICENSE_HOST = "creativecommons.org";

type RejectionKind = "schema" | "license" | "media" | "dimensions" | "url";
type RejectionCounts = Record<RejectionKind, number>;

interface CachedMetadata {
  expiresAt: number;
  body: unknown;
}

export interface CommonsPhotoClientOptions {
  delay?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

interface LicenseRule {
  license: AllowedLicense;
  shortNames: ReadonlySet<string>;
}

const LICENSES = new Map<string, LicenseRule>([
  [
    "https://creativecommons.org/publicdomain/zero/1.0/",
    { license: "CC0", shortNames: new Set(["CC0 1.0"]) },
  ],
  [
    "https://creativecommons.org/publicdomain/mark/1.0/",
    { license: "Public Domain", shortNames: new Set(["Public Domain Mark 1.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by/2.0/",
    { license: "CC BY", shortNames: new Set(["CC BY 2.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by/3.0/",
    { license: "CC BY", shortNames: new Set(["CC BY 3.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by/4.0/",
    { license: "CC BY", shortNames: new Set(["CC BY 4.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by-sa/2.0/",
    { license: "CC BY-SA", shortNames: new Set(["CC BY-SA 2.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by-sa/3.0/",
    { license: "CC BY-SA", shortNames: new Set(["CC BY-SA 3.0"]) },
  ],
  [
    "https://creativecommons.org/licenses/by-sa/4.0/",
    { license: "CC BY-SA", shortNames: new Set(["CC BY-SA 4.0"]) },
  ],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nonNegativeIntegerToken(value: unknown): boolean {
  return nonNegativeInteger(value) ||
    (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

type UrlResult =
  | { status: "accepted"; value: string }
  | { status: "disallowed" | "malformed" };

function hostMatches(hostname: string, expected: string): boolean {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

function httpsUrl(value: unknown, expectedHost?: string): UrlResult {
  if (!nonEmptyString(value)) return { status: "malformed" };
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname === "" ||
      (expectedHost !== undefined && !hostMatches(url.hostname, expectedHost))
    ) {
      return { status: "disallowed" };
    }
    return { status: "accepted", value: url.toString() };
  } catch {
    return { status: "malformed" };
  }
}

function canonicalLicenseUrl(value: unknown): UrlResult {
  const normalized = httpsUrl(value, LICENSE_HOST);
  if (normalized.status !== "accepted") return normalized;
  const url = new URL(normalized.value);
  if (url.search || url.hash) return { status: "disallowed" };
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return { status: "accepted", value: url.toString() };
}

function metadataString(metadata: unknown, field: string): string | null {
  if (!isRecord(metadata) || !isRecord(metadata[field])) return null;
  const value = metadata[field].value;
  return nonEmptyString(value) ? value : null;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/gi, (entity, name: string) => {
    switch (name.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "#39":
        return "'";
      default:
        return entity;
    }
  });
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function creatorUrl(value: string): string | undefined {
  const match = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/i.exec(value);
  if (!match) return undefined;
  const result = httpsUrl(decodeEntities(match[2]));
  return result.status === "accepted" ? result.value : undefined;
}

function rejectionCounts(): RejectionCounts {
  return { schema: 0, license: 0, media: 0, dimensions: 0, url: 0 };
}

type Normalization =
  | { photo: EligiblePhoto }
  | { rejection: RejectionKind; definitive: boolean };

function rejected(
  rejection: RejectionKind,
  definitive = false,
): Normalization {
  return { rejection, definitive };
}

function normalizePage(value: unknown): Normalization {
  if (!isRecord(value)) return rejected("schema");
  const pageId = positiveInteger(value.pageid);
  const fileTitle = nonEmptyString(value.title) ? value.title : null;
  if (pageId === null || !fileTitle) return rejected("schema");
  const pageUrl = httpsUrl(value.canonicalurl, COMMONS_PAGE_HOST);
  if (pageUrl.status !== "accepted") {
    return rejected("url", pageUrl.status === "disallowed");
  }
  if (!Array.isArray(value.imageinfo) || value.imageinfo.length !== 1 || !isRecord(value.imageinfo[0])) {
    return rejected("schema");
  }

  const info = value.imageinfo[0];
  const sourceUrl = httpsUrl(info.url, COMMONS_MEDIA_HOST);
  const previewUrl = httpsUrl(info.thumburl, COMMONS_MEDIA_HOST);
  if (sourceUrl.status === "disallowed" || previewUrl.status === "disallowed") {
    return rejected("url", true);
  }
  if (sourceUrl.status !== "accepted" || previewUrl.status !== "accepted") {
    return rejected("url");
  }

  const width = positiveInteger(info.width);
  const height = positiveInteger(info.height);
  if (width === null || height === null) return rejected("schema");
  if (width < MIN_WIDTH || height < MIN_HEIGHT || width <= height) {
    return rejected("dimensions", true);
  }

  if (!nonEmptyString(info.mediatype) || !nonEmptyString(info.mime)) {
    return rejected("schema");
  }

  if (
    info.mediatype !== "BITMAP" ||
    !info.mime.toLowerCase().startsWith("image/") ||
    info.mime.toLowerCase() === "image/svg+xml"
  ) {
    return rejected("media", true);
  }

  const shortName = metadataString(info.extmetadata, "LicenseShortName");
  const licenseUrl = canonicalLicenseUrl(metadataString(info.extmetadata, "LicenseUrl"));
  if (licenseUrl.status === "disallowed") return rejected("license", true);
  if (!shortName || licenseUrl.status !== "accepted") return rejected("schema");
  const licenseRule = LICENSES.get(licenseUrl.value);
  if (!licenseRule || !licenseRule.shortNames.has(shortName)) {
    return rejected("license", true);
  }

  const artistRaw = metadataString(info.extmetadata, "Artist");
  const descriptionRaw = metadataString(info.extmetadata, "ImageDescription");
  const photographer = artistRaw ? stripHtml(artistRaw) : undefined;
  const photographerUrl = artistRaw ? creatorUrl(artistRaw) : undefined;
  const title = descriptionRaw ? stripHtml(descriptionRaw) : fileTitle;
  if (!title) return rejected("schema");

  const providerId = String(pageId);
  return {
    photo: {
      provider: "commons",
      providerId,
      photoId: globalPhotoId("commons", providerId),
      title,
      ...(photographer ? { photographer } : {}),
      ...(photographerUrl ? { photographerUrl } : {}),
      pageUrl: pageUrl.value,
      license: licenseRule.license,
      licenseUrl: licenseUrl.value,
      sourceUrl: sourceUrl.value,
      previewUrl: previewUrl.value,
      width,
      height,
    },
  };
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryableApiError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    (value.error.code === "maxlag" || value.error.code === "ratelimited")
  );
}

function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function isDefinitiveMissingError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    (value.error.code === "missingtitle" || value.error.code === "nosuchpage")
  );
}

function commonParams(): URLSearchParams {
  return new URLSearchParams({
    action: "query",
    prop: "info|imageinfo",
    inprop: "url",
    iiprop: "url|size|mime|mediatype|extmetadata",
    iiurlwidth: "1024",
    format: "json",
    formatversion: "2",
    maxlag: "5",
  });
}

export class CommonsPhotoClient implements PhotoProviderClient {
  readonly provider = "commons" as const;
  private readonly metadataCache = new Map<string, CachedMetadata>();
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly logger: OperationalLogger,
    options: CommonsPhotoClientOptions = {},
  ) {
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    const exponential = 250 * 2 ** attempt;
    const jittered = Math.floor(exponential * (0.5 + this.random() * 0.5));
    return Math.max(jittered, retryAfterMs(retryAfter, this.now()) ?? 0);
  }

  private async request(params: URLSearchParams, operation: string): Promise<unknown> {
    const endpoint = new URL(COMMONS_ENDPOINT);
    endpoint.search = params.toString();
    const key = endpoint.toString();
    const cached = this.metadataCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.body;
    if (cached) this.metadataCache.delete(key);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(key, {
          headers: new Headers({
            "User-Agent": OUTBOUND_USER_AGENT,
            "Api-User-Agent": OUTBOUND_USER_AGENT,
          }),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new ProviderTransientError(`${operation} failed`);
        }
        await this.delay(this.backoffMs(attempt, null));
        continue;
      }
      if (isTransientStatus(response.status)) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new ProviderTransientError(
            `${operation} temporarily failed with HTTP ${response.status}`,
          );
        }
        await this.delay(this.backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      if (!response.ok) {
        throw new ProviderTransientError(`${operation} failed with HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderTransientError(`${operation} returned malformed JSON`);
      }
      if (retryableApiError(body)) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new ProviderTransientError(`${operation} returned a retryable API error`);
        }
        await this.delay(this.backoffMs(attempt, response.headers.get("retry-after")));
        continue;
      }
      if (!(isRecord(body) && "error" in body && body.error !== undefined)) {
        this.metadataCache.set(key, {
          body,
          expiresAt: this.now() + METADATA_CACHE_TTL_MS,
        });
      }
      return body;
    }

    throw new ProviderTransientError(`${operation} failed`);
  }

  async search(_nowMs: number, pass: SearchPass): Promise<RankedCandidate[]> {
    const candidates: RankedCandidate[] = [];
    const seenPageIds = new Set<string>();
    let searchRank = 0;

    for (const query of PROVIDER_SEARCH_TERMS) {
      const counts = rejectionCounts();
      let eligible = 0;
      let returned = 0;
      let continuation: Record<string, string> | undefined;

      for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES_PER_QUERY; pageNumber += 1) {
        const params = commonParams();
        params.set("generator", "search");
        params.set("gsrnamespace", "6");
        params.set("gsrsearch", `filetype:bitmap ${query}`);
        params.set("gsrlimit", "20");
        if (pass === "recent") params.set("gsrsort", "create_timestamp_desc");
        if (continuation) {
          for (const [name, value] of Object.entries(continuation)) params.set(name, value);
        }

        const body = await this.request(params, "Commons search");
        if (!isRecord(body) || ("error" in body && body.error !== undefined)) {
          throw new ProviderTransientError("Commons search returned an API error");
        }
        const pages = body.query === undefined ? [] : isRecord(body.query) ? body.query.pages : null;
        if (!Array.isArray(pages)) {
          throw new ProviderTransientError("Commons search returned malformed data");
        }
        returned += pages.length;
        for (const page of pages) {
          const rank = searchRank;
          searchRank += 1;
          const normalized = normalizePage(page);
          if ("rejection" in normalized) {
            counts[normalized.rejection] += 1;
            continue;
          }
          if (seenPageIds.has(normalized.photo.providerId)) continue;
          seenPageIds.add(normalized.photo.providerId);
          candidates.push({ photo: normalized.photo, searchRank: rank });
          eligible += 1;
        }

        if (body.continue === undefined) break;
        if (!isRecord(body.continue)) {
          throw new ProviderTransientError("Commons search returned malformed continuation");
        }
        const tokens = Object.entries(body.continue);
        const moduleTokens = tokens.filter(([name]) => name !== "continue");
        if (
          !nonEmptyString(body.continue.continue) ||
          moduleTokens.length === 0 ||
          moduleTokens.some(
            ([name, value]) =>
              name.length === 0 ||
              (name === "gsroffset"
                ? !nonNegativeIntegerToken(value)
                : !nonEmptyString(value) && !nonNegativeInteger(value)),
          )
        ) {
          throw new ProviderTransientError("Commons search returned malformed continuation");
        }
        continuation = Object.fromEntries(
          tokens.map(([name, value]) => [name, String(value)]),
        );
      }
      this.logger.info({
        event: "provider_search",
        provider: this.provider,
        query,
        pass,
        returned,
        eligible,
        rejections: counts,
      });
    }
    return candidates;
  }

  async isAvailable(photo: EligiblePhoto): Promise<boolean> {
    return checkSourceAvailability(this.fetcher, photo);
  }

  async isEligible(photo: EligiblePhoto): Promise<boolean> {
    const params = commonParams();
    params.set("pageids", photo.providerId);
    const body = await this.request(params, "Commons revalidation");
    if (isDefinitiveMissingError(body)) return false;
    if (!isRecord(body)) {
      throw new ProviderTransientError("Commons revalidation returned malformed data");
    }
    if ("error" in body && body.error !== undefined) {
      throw new ProviderTransientError("Commons revalidation returned an API error");
    }
    if (!isRecord(body.query) || !Array.isArray(body.query.pages)) {
      throw new ProviderTransientError("Commons revalidation returned malformed data");
    }
    if (body.query.pages.length === 0) return false;
    if (body.query.pages.length !== 1) {
      throw new ProviderTransientError("Commons revalidation returned malformed data");
    }
    if (
      isRecord(body.query.pages[0]) &&
      body.query.pages[0].missing === true
    ) {
      return false;
    }

    const normalized = normalizePage(body.query.pages[0]);
    if ("rejection" in normalized) {
      if (normalized.definitive) return false;
      throw new ProviderTransientError("Commons revalidation returned malformed data");
    }
    const current = normalized.photo;
    if (current.providerId !== photo.providerId) {
      throw new ProviderTransientError("Commons revalidation returned malformed data");
    }
    if (current.sourceUrl !== photo.sourceUrl) return false;
    if (current.license !== photo.license || current.licenseUrl !== photo.licenseUrl) {
      return false;
    }
    return current.width >= photo.width && current.height >= photo.height;
  }
}
