import { QUALITY_THRESHOLD } from "./config";
import type { EligiblePhoto, QualityAssessment } from "./model";

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct" as const;
export const QUALITY_MAX_TOKENS = 32;

export const QUALITY_PROMPT = `Evaluate this image as a standalone daily photograph of cattle grazing outdoors in a pasture. Award integer points for technical quality (maximum 30), cattle visibility and pasture relevance (maximum 30), composition (maximum 20), landscape atmosphere (maximum 15), and a clean distraction-free frame (maximum 5). Higher is always better. Use the full range. A sharp, attractive pasture photo with prominent cattle and no hard reject should normally total 82 to 95. Hard reject non-photographs or synthetic-looking images; dominant people or machinery; cattle that are tiny, distant, or insignificant; watermarks, borders, or text; blur, noise, compression damage, severe exposure/color problems; or weak standalone composition.
Return exactly one line: SCORE|technical points|subject points|composition points|landscape points|clean-frame points|hard-reject flag|PASS
Use 0 when there is no hard reject and 1 when there is. PASS requires a 0 flag; replace PASS with REJECT and use a 1 flag if any hard-reject rule applies. Output only the line, using seven vertical bars and no labels, explanation, or placeholders.`;

type QualityComponents = Omit<QualityAssessment, "total" | "passed">;

export interface QualityScoringFailure {
  photoId: string;
  stage: "preview" | "ai" | "parse";
  detail: string;
}

export type QualityFailureReporter = (failure: QualityScoringFailure) => void;

const componentBounds = {
  technical: 30,
  subject: 30,
  composition: 20,
  landscape: 15,
  distractions: 5,
} as const;

const qualityFields = new Set([
  ...Object.keys(componentBounds),
  "hardRejects",
  "reasons",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapResponse(value: unknown): unknown {
  if (typeof value === "string") {
    return parseJson(value) ?? value;
  }

  if (isRecord(value) && typeof value.response === "string") {
    return parseJson(value.response) ?? value.response;
  }

  if (isRecord(value) && "response" in value) {
    return value.response;
  }

  return value;
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export function parseQualityResponse(value: unknown): QualityAssessment | null {
  const candidate = unwrapResponse(value);
  if (typeof candidate === "string") {
    const match = /^SCORE\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(?:(0|1)\|)?(PASS|REJECT)$/.exec(
      candidate.trim(),
    );
    if (!match) return null;
    const hardRejectFlag = match[6];
    const verdict = match[7];
    if (
      hardRejectFlag !== undefined &&
      (hardRejectFlag === "1") !== (verdict === "REJECT")
    ) {
      return null;
    }

    const components: QualityComponents = {
      technical: Number(match[1]),
      subject: Number(match[2]),
      composition: Number(match[3]),
      landscape: Number(match[4]),
      distractions: Number(match[5]),
      hardRejects: verdict === "REJECT" ? ["vision model hard rejection"] : [],
      reasons: [],
    };
    for (const [field, maximum] of Object.entries(componentBounds)) {
      if (!isBoundedInteger(components[field as keyof typeof componentBounds], maximum)) {
        return null;
      }
    }
    const total =
      components.technical +
      components.subject +
      components.composition +
      components.landscape +
      components.distractions;
    return {
      ...components,
      total,
      passed: total >= QUALITY_THRESHOLD && components.hardRejects.length === 0,
    };
  }
  if (!isRecord(candidate)) {
    return null;
  }

  const candidateFields = Object.keys(candidate);
  if (
    candidateFields.length !== qualityFields.size ||
    candidateFields.some((field) => !qualityFields.has(field))
  ) {
    return null;
  }

  for (const [field, maximum] of Object.entries(componentBounds)) {
    if (!isBoundedInteger(candidate[field], maximum)) {
      return null;
    }
  }

  if (!isStringArray(candidate.hardRejects) || !isStringArray(candidate.reasons)) {
    return null;
  }

  const components: QualityComponents = {
    technical: candidate.technical as number,
    subject: candidate.subject as number,
    composition: candidate.composition as number,
    landscape: candidate.landscape as number,
    distractions: candidate.distractions as number,
    hardRejects: candidate.hardRejects,
    reasons: candidate.reasons,
  };
  const total =
    components.technical +
    components.subject +
    components.composition +
    components.landscape +
    components.distractions;

  return {
    ...components,
    total,
    passed: total >= QUALITY_THRESHOLD && components.hardRejects.length === 0,
  };
}

export class QualityScorer {
  constructor(
    private readonly ai: Pick<Ai, "run">,
    private readonly fetcher: typeof fetch = fetch,
    private readonly reportFailure: QualityFailureReporter = () => undefined,
  ) {}

  async score(photo: EligiblePhoto): Promise<QualityAssessment | null> {
    let image: number[];
    try {
      const preview = await this.fetcher(photo.previewUrl);
      if (!preview.ok) {
        this.reportFailure({
          photoId: photo.photoId,
          stage: "preview",
          detail: `preview request returned HTTP ${preview.status}`,
        });
        return null;
      }

      image = Array.from(new Uint8Array(await preview.arrayBuffer()));
    } catch (error: unknown) {
      this.reportFailure({
        photoId: photo.photoId,
        stage: "preview",
        detail: `preview request failed with ${errorName(error)}`,
      });
      return null;
    }

    let result: unknown;
    try {
      result = await this.ai.run(VISION_MODEL, {
        image,
        prompt: QUALITY_PROMPT,
        temperature: 0,
        max_tokens: QUALITY_MAX_TOKENS,
      });
    } catch (error: unknown) {
      this.reportFailure({
        photoId: photo.photoId,
        stage: "ai",
        detail: `Workers AI request failed with ${errorName(error)}`,
      });
      return null;
    }

    const assessment = parseQualityResponse(result);
    if (!assessment) {
      this.reportFailure({
        photoId: photo.photoId,
        stage: "parse",
        detail: "Workers AI response did not match the quality schema",
      });
    }
    return assessment;
  }
}
