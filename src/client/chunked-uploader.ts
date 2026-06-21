/**
 * Chunked (resumable) upload — client side.
 *
 * Slices a File into chunks small enough to clear the hosting proxy's body cap
 * and POSTs them sequentially to the chunk endpoint, reporting real progress per
 * completed chunk. Framework-agnostic: call it from React, Vue, Svelte or plain
 * JS and feed `onProgress` into whatever UI you have.
 */

export interface ChunkedUploadOptions {
  /** Endpoint that implements the server handler (see ../server/upload-chunk). */
  endpoint?: string;
  /** Chunk size in bytes. Keep it under your proxy's body limit. */
  chunkSize?: number;
  /** 0–100, fired after each chunk lands. */
  onProgress?: (percent: number) => void;
  /** Extra form fields sent with every chunk (e.g. a folder/bucket). */
  fields?: Record<string, string>;
}

export interface ChunkedUploadResult {
  path: string;
  name: string;
  type: string;
  size: number;
}

const EXT_TYPE: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export async function uploadInChunks(
  file: File,
  options: ChunkedUploadOptions = {},
): Promise<ChunkedUploadResult> {
  const endpoint = options.endpoint ?? "/api/upload-chunk";
  const chunkSize = options.chunkSize ?? 5 * 1024 * 1024; // 5 MB
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Some browsers leave File.type empty for .mov/.webm — infer from extension.
  const fileType =
    file.type || EXT_TYPE[file.name.split(".").pop()?.toLowerCase() ?? ""] || "";

  let result: ChunkedUploadResult | undefined;

  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkSize;
    const blob = file.slice(start, start + chunkSize);

    const data = new FormData();
    for (const [k, v] of Object.entries(options.fields ?? {})) data.append(k, v);
    data.append("uploadId", uploadId);
    data.append("fileName", file.name);
    data.append("fileType", fileType);
    data.append("chunkIndex", String(index));
    data.append("totalChunks", String(totalChunks));
    data.append("chunk", blob);

    const response = await fetch(endpoint, { method: "POST", body: data });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Upload failed at chunk ${index}`);
    }

    if (payload?.path) result = payload as ChunkedUploadResult;
    options.onProgress?.(Math.round(((index + 1) / totalChunks) * 100));
  }

  if (!result) throw new Error("Upload finished without a final path");
  return result;
}
