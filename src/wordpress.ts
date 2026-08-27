import {
  OUTBOUND_USER_AGENT,
  PROVIDER_SEARCH_TERMS,
  WORDPRESS_ENDPOINT,
  WORDPRESS_LANDSCAPE_ORIENTATION_ID,
} from "./config";
import type { OperationalLogger } from "./lifecycle";
import type { EligiblePhoto } from "./model";
import {
  checkSourceAvailability,
  globalPhotoId,
  ProviderTransientError,
  type PhotoProviderClient,
  type RankedCandidate,
  type SearchPass,
} from "./provider";

const PAGE_SIZE = 20;
const MAX_CONCURRENT_SEARCHES = 3;
const CC0_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

type RejectionKind = "schema" | "media" | "dimensions" | "url";

interface RejectionCounts {
  schema: number;
  media: number;
  dimensions: number;
  url: number;
}

interface SearchResult {
  transient: boolean;
  records: Array<{ candidate: EligiblePhoto; index: number }>;
  returnedCount: number;
  eligibleCount: number;
  rejected: RejectionCounts;
}

type NormalizationResult =
  | { candidate: EligiblePhoto }
  | { rejection: RejectionKind; definitive: boolean };

function emptyRejections(): RejectionCounts {
  return { schema: 0, media: 0, dimensions: 0, url: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

type UrlStatus = "accepted" | "disallowed" | "malformed";

function httpsUrlStatus(value: unknown): UrlStatus {
  if (!isNonEmptyString(value)) return "malformed";
  try {
    return new URL(value).protocol === "https:" ? "accepted" : "disallowed";
  } catch {
    return "malformed";
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function rejected(
  rejection: RejectionKind,
  definitive = false,
): NormalizationResult {
  return { rejection, definitive };
}

function normalizePhoto(value: unknown): NormalizationResult {
  if (!isRecord(value)) return rejected("schema");
  const {
    id,
    featured_media: featuredMediaId,
    status,
    type,
    link,
    content,
    _embedded: embedded,
  } = value;
  const orientations = value["photo-orientations"];
  if (!isPositiveInteger(id)) return rejected("schema");
  if (typeof status !== "string" || typeof type !== "string") {
    return rejected("schema");
  }
  if (status !== "publish" || type !== "photo") return rejected("schema", true);
  if (
    !Array.isArray(orientations) ||
    orientations.length !== 1 ||
    typeof orientations[0] !== "number"
  ) {
    return rejected("schema");
  }
  if (orientations[0] !== WORDPRESS_LANDSCAPE_ORIENTATION_ID) {
    return rejected("schema", true);
  }
  if (!isNonEmptyString(link)) return rejected("url");
  const linkStatus = httpsUrlStatus(link);
  if (linkStatus !== "accepted") return rejected("url", linkStatus === "disallowed");
  if (!isRecord(content) || !isNonEmptyString(content.rendered)) {
    return rejected("schema");
  }
  const title = htmlToText(content.rendered);
  if (!title) return rejected("schema");

  if (!isRecord(embedded)) return rejected("media");
  const authors = embedded.author;
  const featured = embedded["wp:featuredmedia"];
  if (!Array.isArray(authors) || authors.length < 1 || !Array.isArray(featured) || featured.length < 1) {
    return rejected("media");
  }
  const author = authors[0];
  const media = featured[0];
  if (!isRecord(author) || !isNonEmptyString(author.name)) return rejected("schema");
  if (!isNonEmptyString(author.link)) return rejected("url");
  const authorUrlStatus = httpsUrlStatus(author.link);
  if (authorUrlStatus !== "accepted") {
    return rejected("url", authorUrlStatus === "disallowed");
  }
  if (!isRecord(media)) return rejected("media");
  if (!isPositiveInteger(featuredMediaId) || !isPositiveInteger(media.id)) {
    return rejected("media");
  }
  if (featuredMediaId !== media.id) return rejected("media", true);
  if (typeof media.media_type !== "string" || typeof media.mime_type !== "string") {
    return rejected("media");
  }
  if (media.media_type !== "image" || media.mime_type !== "image/jpeg") {
    return rejected("media", true);
  }
  if (!isNonEmptyString(media.source_url)) return rejected("url");
  const sourceUrlStatus = httpsUrlStatus(media.source_url);
  if (sourceUrlStatus !== "accepted") {
    return rejected("url", sourceUrlStatus === "disallowed");
  }

  const details = media.media_details;
  if (!isRecord(details) || !isPositiveInteger(details.width) || !isPositiveInteger(details.height)) {
    return rejected("schema");
  }
  const sizes = details.sizes;
  if (!isRecord(sizes) || !isRecord(sizes.large)) {
    return rejected("url");
  }
  if (!isNonEmptyString(sizes.large.source_url)) return rejected("url");
  const previewUrlStatus = httpsUrlStatus(sizes.large.source_url);
  if (previewUrlStatus !== "accepted") {
    return rejected("url", previewUrlStatus === "disallowed");
  }
  if (details.width < 1920 || details.height < 1080 || details.width <= details.height) {
    return rejected("dimensions", true);
  }

  const providerId = String(id);
  return {
    candidate: {
      provider: "wordpress",
      providerId,
      photoId: globalPhotoId("wordpress", providerId),
      title,
      photographer: author.name,
      photographerUrl: author.link,
      pageUrl: link,
      license: "CC0",
      licenseUrl: CC0_LICENSE_URL,
      sourceUrl: media.source_url,
      previewUrl: sizes.large.source_url,
      width: details.width,
      height: details.height,
    },
  };
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function decodeArray(response: Response): Promise<unknown[] | null> {
  if (!response.ok) return null;
  try {
    const decoded: unknown = await response.json();
    return Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

async function boundedMap<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

export class WordPressPhotoClient implements PhotoProviderClient {
  readonly provider = "wordpress" as const;

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly logger: OperationalLogger,
  ) {}

  async search(nowMs: number, pass: SearchPass): Promise<RankedCandidate[]> {
    const results = await boundedMap(
      PROVIDER_SEARCH_TERMS,
      MAX_CONCURRENT_SEARCHES,
      (query) => this.searchQuery(query, pass, nowMs),
    );
    if (results.every((result) => result.transient)) {
      throw new ProviderTransientError("WordPress photo search temporarily failed");
    }

    const unique = new Map<string, RankedCandidate>();
    for (const [queryIndex, result] of results.entries()) {
      for (const { candidate, index } of result.records) {
        const searchRank = queryIndex * PAGE_SIZE + index;
        const existing = unique.get(candidate.photoId);
        if (!existing || searchRank < existing.searchRank) {
          unique.set(candidate.photoId, { photo: candidate, searchRank });
        }
      }
    }
    return [...unique.values()].sort((left, right) => left.searchRank - right.searchRank);
  }

  private async searchQuery(
    query: string,
    pass: SearchPass,
    nowMs: number,
  ): Promise<SearchResult> {
    const rejected = emptyRejections();
    const params = new URLSearchParams({
      _embed: "1",
      "photo-orientations": String(WORDPRESS_LANDSCAPE_ORIENTATION_ID),
      per_page: String(PAGE_SIZE),
      search: query,
      orderby: pass === "recent" ? "date" : "relevance",
      order: "desc",
      page: "1",
    });
    const base: SearchResult = {
      transient: false,
      records: [],
      returnedCount: 0,
      eligibleCount: 0,
      rejected,
    };

    let response: Response;
    try {
      response = await this.fetcher(`${WORDPRESS_ENDPOINT}?${params.toString()}`, {
        headers: { "User-Agent": OUTBOUND_USER_AGENT },
      });
    } catch {
      return this.logSearch(query, pass, nowMs, { ...base, transient: true });
    }
    if (isTransientStatus(response.status)) {
      return this.logSearch(query, pass, nowMs, { ...base, transient: true });
    }

    const records = await decodeArray(response);
    if (!records) return this.logSearch(query, pass, nowMs, base);
    base.returnedCount = records.length;
    for (const [index, record] of records.entries()) {
      const normalized = normalizePhoto(record);
      if ("rejection" in normalized) {
        rejected[normalized.rejection] += 1;
        continue;
      }
      base.records.push({ candidate: normalized.candidate, index });
    }
    base.eligibleCount = base.records.length;
    return this.logSearch(query, pass, nowMs, base);
  }

  private logSearch(
    query: string,
    pass: SearchPass,
    nowMs: number,
    result: SearchResult,
  ): SearchResult {
    this.logger.info({
      event: "provider_search",
      at: new Date(nowMs).toISOString(),
      provider: this.provider,
      query,
      pass,
      returnedCount: result.returnedCount,
      eligibleCount: result.eligibleCount,
      rejected: result.rejected,
    });
    return result;
  }

  async isAvailable(photo: EligiblePhoto): Promise<boolean> {
    return checkSourceAvailability(this.fetcher, photo);
  }

  async isEligible(photo: EligiblePhoto): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${WORDPRESS_ENDPOINT}/${encodeURIComponent(photo.providerId)}?_embed=1`,
        { headers: { "User-Agent": OUTBOUND_USER_AGENT } },
      );
    } catch {
      throw new ProviderTransientError("WordPress eligibility check failed");
    }
    if (response.status === 404 || response.status === 410) return false;
    if (isTransientStatus(response.status)) {
      throw new ProviderTransientError(
        `WordPress eligibility check temporarily failed with HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw new ProviderTransientError(
        `WordPress eligibility check failed with HTTP ${response.status}`,
      );
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new ProviderTransientError("WordPress eligibility check returned malformed JSON");
    }
    const normalized = normalizePhoto(decoded);
    if ("rejection" in normalized) {
      if (normalized.definitive) return false;
      throw new ProviderTransientError("WordPress eligibility check returned malformed data");
    }
    const current = normalized.candidate;
    return (
      current.provider === photo.provider &&
      current.providerId === photo.providerId &&
      current.photoId === photo.photoId &&
      current.pageUrl === photo.pageUrl &&
      current.sourceUrl === photo.sourceUrl &&
      current.width === photo.width &&
      current.height === photo.height &&
      current.license === photo.license &&
      current.licenseUrl === photo.licenseUrl
    );
  }
}
