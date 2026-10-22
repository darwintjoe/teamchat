/** Convex wraps thrown server errors with request metadata; keep the human-readable line. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const uncaught = raw.match(/Uncaught Error:\s*([^\n]*)/);
  if (uncaught !== null) return uncaught[1].trim();
  return raw
    .replace(/^\[CONVEX[^\]]*\]\s*/, "")
    .replace(/^\[Request ID:[^\]]*\]\s*/, "")
    .split("\n")[0]
    .trim();
}
