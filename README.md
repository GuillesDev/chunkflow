# Resumable chunked upload (large files past proxy body limits)

A small, framework-light reference implementation for uploading **large files
(hundreds of MB to GBs) from the browser to your own server** when a managed
host or reverse proxy caps request body size.

> Pattern extracted and sanitized from a production project I built ([Black Gum](https://blackgumgroup.com), a custom CMS with an admin panel that uploads video). No secrets, no client data, just the engineering.

## The problem

Most managed hosts and reverse proxies cap the request body (often 4–100 MB).
A single multipart `POST` of a 300 MB video is rejected **before it ever reaches
your app**, and you don't always control the proxy config. The usual "answer" is
an external object store (S3/R2) + presigned URLs, which is great but overkill when you
already have disk on the box and just need big files to land.

## The approach

```
browser                              server                         disk
  │  slice file into ≤5 MB chunks      │                              │
  ├─ POST chunk 0 ────────────────────►│  writeFile(tmp, chunk)  ─────►│ upload.part
  ├─ POST chunk 1 ────────────────────►│  appendFile(tmp, chunk) ─────►│ (+append)
  ├─ … (sequential, with progress)     │                              │
  └─ POST chunk N (last) ─────────────►│  validate magic bytes        │
                                       │  rename(tmp → final)    ─────►│ video-123.mp4
```

1. **Client** slices the file into chunks small enough to clear the proxy cap and
   sends them one at a time, advancing a real progress bar per chunk.
2. **Server** appends each chunk to a temporary `.part` file. It **never holds the
   whole file in memory** (a 2 GB upload uses kilobytes of RAM, not gigabytes).
3. On the **final chunk**, it validates the assembled file's *magic bytes* against
   the declared MIME type, then does an **atomic `rename`** into its final spot.

## Why it's built this way

- **Constant memory.** `appendFile` streams to disk; memory use is independent of
  file size. No buffering multi-GB blobs in a serverless function.
- **Atomicity.** Writing to a temp file and renaming on success means a reader
  (or a crashed upload) never sees a half-written file.
- **Resumable-friendly.** Each chunk carries an `uploadId` + index, so the model
  extends naturally to resume-after-failure.

## Security (the part that matters)

- **Magic-byte validation**, not just the filename or the `Content-Type` header,
  so an attacker can't smuggle an HTML/script payload in under a `.mp4` name.
- **Hard ceilings** on both chunk size and assembled total size, to guard the disk
  against a runaway or compromised session.
- **Filename sanitization**: accents stripped, lowercased, collision-resistant
  timestamp, extension preserved. No path traversal, no overwrite surprises.
- **Auth hook** (`requireAuth`) you wire to your own session/admin check.

## Files

| File | What it is |
|------|------------|
| [`src/shared/upload.ts`](src/shared/upload.ts) | The reusable bits: magic-byte validation + safe filenames |
| [`src/server/upload-chunk.ts`](src/server/upload-chunk.ts) | The route handler that appends chunks and finalizes |
| [`src/client/chunked-uploader.ts`](src/client/chunked-uploader.ts) | Framework-agnostic client that slices + reports progress |

## Notes

This is a **pattern, not a drop-in package.** Auth, the storage directory and the
bucket policy are intentionally left as stubs to wire into your own stack. Serve
the finished files with a Range-capable handler (HTTP 206) if you need video
seeking.

## License

MIT © Guillermo López
