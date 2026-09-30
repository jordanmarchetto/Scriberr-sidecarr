import type { ScriberrApi } from "./scriberr-api.js";
import type { ScriberrJob } from "./types.js";

export interface JobTitleGenerator {
  generate(job: ScriberrJob, fallbackTimestamp: string): Promise<string>;
}

export class ScriberrJobTitleGenerator implements JobTitleGenerator {
  constructor(private readonly api: ScriberrApi) {}

  async generate(job: ScriberrJob, fallbackTimestamp: string): Promise<string> {
    return buildDisplayTitle(await this.api.generateTitleSubject(job.id), job.created_at ?? fallbackTimestamp);
  }
}

export function buildDisplayTitle(subject: string, timestamp?: string): string {
  const firstLine = subject.split(/\r?\n/, 1)[0] ?? "";
  const cleaned = firstLine
    .replace(/^\s*(?:title\s*:\s*)?/i, "")
    .replace(/^[\s#*_`'\"]+|[\s#*_`'\".!?:;,\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new Error("Scriberr returned an empty generated title");
  if (/^(?:error\s*:|request timeout)/i.test(cleaned)) {
    throw new Error("Scriberr title generation did not complete");
  }

  const date = recordingDate(timestamp);
  const available = Math.max(1, 60 - date.length - 3);
  const shortened = cleaned.length > available
    ? `${cleaned.slice(0, Math.max(1, available - 1)).trimEnd()}…`
    : cleaned;
  return `${date} - ${shortened}`;
}

function recordingDate(timestamp?: string): string {
  const match = timestamp?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
  throw new Error("Recording date is unavailable for generated title");
}
