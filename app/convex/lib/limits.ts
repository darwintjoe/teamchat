// SAL per-file and per-org limits (v0 brief: size and type limits, per-org byte cap).

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file

/** TeamChat-paid demo bucket cap per org. Override with TEAMCHAT_ORG_STORAGE_CAP_BYTES. */
export function orgStorageCapBytes(): number {
  const raw = process.env.TEAMCHAT_ORG_STORAGE_CAP_BYTES;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5 * 1024 * 1024 * 1024; // 5 GiB
}

// "Photos, video, audio files and any file attachment" (CR-18): anything in these families
// passes; an explicit exact list covers documents and archives; executables and scripts do not.
const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];

const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "text/markdown",
]);

export function isAllowedMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  if (ALLOWED_MIME_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return ALLOWED_MIME_EXACT.has(lower);
}

export function assertAllowedFile(args: { name: string; mime: string; size: number }): void {
  if (!Number.isFinite(args.size) || args.size <= 0) {
    throw new Error("File size must be a positive number of bytes");
  }
  if (args.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large: ${args.size} bytes; the limit is ${MAX_FILE_BYTES} bytes (25 MB)`,
    );
  }
  if (!isAllowedMime(args.mime)) {
    throw new Error(`Content type "${args.mime}" is not allowed`);
  }
}

/** Keys are server-generated; names only contribute a readable suffix. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "file";
}
