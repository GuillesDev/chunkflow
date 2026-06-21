import path from "node:path";

/**
 * MIME types this uploader accepts. Keep this allow-list tight — it's the first
 * gate, and it pairs with the magic-byte check below (a header alone is trivial
 * to spoof).
 */
export const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

/**
 * Turn an arbitrary upload filename into a safe, collision-resistant name.
 * Strips accents, lowercases, keeps the extension, appends a timestamp so two
 * uploads of "video.mp4" never clobber each other. Also kills path-traversal
 * (`../`) since only `[a-z0-9-]` survives.
 */
export function safeName(name: string) {
  const ext = path.extname(name).toLowerCase();
  const base = path
    .basename(name, ext)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);

  return `${base || "asset"}-${Date.now()}${ext}`;
}

/**
 * Validate that the leading bytes of a file actually match its declared MIME
 * type. The browser's `Content-Type` and the filename can both lie; the bytes
 * can't (cheaply). Only the first ~16 bytes are needed.
 *
 * This is what stops someone from POSTing an HTML/JS file named `clip.mp4` and
 * having it served back from your domain.
 */
export function hasAllowedMagicBytes(type: string, bytes: Buffer) {
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/png") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  }
  if (type === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (type === "video/mp4" || type === "video/quicktime") {
    // ISO base media: bytes 4–8 are the `ftyp` box type.
    return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (type === "video/webm") {
    // EBML / Matroska header.
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }
  return false;
}
