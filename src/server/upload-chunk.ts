import { mkdir, appendFile, writeFile, rename, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import { ALLOWED_TYPES, hasAllowedMagicBytes, safeName } from "../shared/upload";

/**
 * Chunked (resumable) upload — server side.
 *
 * The browser slices a large file into small parts and POSTs them one by one.
 * Each request stays under the hosting proxy's body cap, so big files get
 * through. We append each part to a temp `.part` file on disk — never holding
 * the whole file in memory — then validate magic bytes and atomically rename
 * the temp file into place on the final chunk.
 *
 * Written as a Web-standard `Request → Response` handler so it drops into any
 * framework that speaks the Fetch API (Next.js route handlers, Hono, etc.).
 */

// Where finished files land. Wire this to your own storage root.
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB — disk guard
const MAX_CHUNK_SIZE = 12 * 1024 * 1024; // 12 MB — comfortably under proxy caps

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const sanitizeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

/**
 * Stub: replace with your real session/admin check. Return a truthy principal
 * to allow the upload, or `null` to reject.
 */
async function requireAuth(_request: Request): Promise<unknown | null> {
  return {}; // TODO: wire to your auth
}

export async function POST(request: Request) {
  if (!(await requireAuth(request))) return json({ error: "Unauthorized" }, 401);

  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Bad request" }, 400);

  const uploadId = sanitizeId(String(form.get("uploadId") || ""));
  const fileName = String(form.get("fileName") || "");
  const fileType = String(form.get("fileType") || "");
  const chunkIndex = Number(form.get("chunkIndex"));
  const totalChunks = Number(form.get("totalChunks"));
  const chunk = form.get("chunk");

  // ── Validate the envelope before touching disk ──
  if (!uploadId || !(chunk instanceof File)) return json({ error: "Invalid upload data" }, 400);
  if (!ALLOWED_TYPES.has(fileType)) return json({ error: "Unsupported format" }, 415);
  if (
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(totalChunks) ||
    chunkIndex < 0 ||
    totalChunks <= 0 ||
    chunkIndex >= totalChunks
  ) {
    return json({ error: "Invalid chunk index" }, 400);
  }
  if (chunk.size > MAX_CHUNK_SIZE) return json({ error: "Chunk too large" }, 413);

  const tmpDir = path.join(UPLOAD_ROOT, ".tmp");
  const tmpPath = path.join(tmpDir, `${uploadId}.part`);
  const bytes = Buffer.from(await chunk.arrayBuffer());

  try {
    await mkdir(tmpDir, { recursive: true });
    // First chunk starts a fresh file (overwrites any stale temp); the rest
    // append in order — the client sends them sequentially.
    if (chunkIndex === 0) await writeFile(tmpPath, bytes);
    else await appendFile(tmpPath, bytes);
  } catch (err) {
    console.error("chunk write failed:", tmpPath, err);
    return json({ error: "Could not store chunk (check write permissions)" }, 500);
  }

  // Running total guard — stop a runaway upload mid-stream.
  const { size } = await stat(tmpPath);
  if (size > MAX_TOTAL_SIZE) {
    await rm(tmpPath, { force: true });
    return json({ error: "File too large" }, 413);
  }

  // Not the last chunk → ack and wait for the next one.
  if (chunkIndex < totalChunks - 1) return json({ ok: true, received: chunkIndex });

  // ── Final chunk: validate the assembled file's magic bytes, then finalize ──
  let head: Buffer;
  try {
    const fh = await open(tmpPath, "r");
    head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
  } catch (err) {
    console.error("finalize read failed:", tmpPath, err);
    await rm(tmpPath, { force: true });
    return json({ error: "Could not finalize upload" }, 500);
  }

  if (!hasAllowedMagicBytes(fileType, head)) {
    await rm(tmpPath, { force: true });
    return json({ error: "File contents do not match the declared format" }, 400);
  }

  const finalName = safeName(fileName || `upload.${fileType.split("/")[1] || "bin"}`);
  const finalPath = path.join(UPLOAD_ROOT, finalName);

  try {
    await rename(tmpPath, finalPath); // atomic: readers never see a partial file
  } catch (err) {
    console.error("finalize rename failed:", finalPath, err);
    await rm(tmpPath, { force: true });
    return json({ error: "Could not finalize upload" }, 500);
  }

  return json({ path: `/uploads/${finalName}`, name: finalName, type: fileType, size });
}
