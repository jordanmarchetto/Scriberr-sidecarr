const sensitiveValuePattern = /\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/gi;
const urlCredentialsPattern = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

export function sanitizeError(error: unknown, maxLength = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(urlCredentialsPattern, "$1[REDACTED]@")
    .replace(sensitiveValuePattern, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
