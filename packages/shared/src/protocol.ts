// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The wire contract between the Marrow client and server (SPEC §7, Appendix A).
 *
 * Pure types + small pure helpers only — no Node or browser APIs — so this file
 * imports cleanly into both the Cloudflare Worker and the Vite/React build. The
 * server derives its request validators from these shapes; the client consumes
 * them directly and also imports the server's Hono `AppType` for typed RPC.
 */

import type { PLATFORMS } from "./constants";

/** Operating-system family a device runs on. */
export type Platform = (typeof PLATFORMS)[number];

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

/** A content-addressed chunk: BLAKE3 hash of the plaintext + its byte length. */
export interface ChunkRef {
  /** Lowercase hex BLAKE3 hash. Also the R2 object key. */
  hash: string;
  /** Plaintext byte length of the chunk. */
  size: number;
}

/**
 * An immutable snapshot of one file's content + metadata — the file's "recipe".
 * A {@link VersionManifest} with `deleted: true` is a tombstone (the chunk list
 * is empty).
 */
export interface VersionManifest {
  /** POSIX-normalized path, relative to the sync root. */
  path: string;
  /** Total reassembled file size in bytes. */
  size: number;
  /** Source mtime in epoch milliseconds. */
  mtime: number;
  /** Unix permission bits (e.g. executable). Omitted on platforms without them. */
  mode?: number;
  /** Ordered list of chunk hashes that reassemble the file. */
  chunks: string[];
  /** Tombstone marker. When true, `chunks` is empty and the path is deleted. */
  deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Devices  —  POST/GET/DELETE /api/devices
// ---------------------------------------------------------------------------

export interface DeviceRegisterRequest {
  /** Human-friendly device name, e.g. "Alex's MacBook". */
  name: string;
  platform: Platform;
}

export interface DeviceRegisterResponse {
  /** The new device id (uuid). */
  id: string;
  /**
   * The raw device token, **shown exactly once**. The client stores it only in
   * the OS secure store; the server keeps just its hash.
   */
  token: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: Platform;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds, or null if never seen since registration. */
  lastSeenAt: number | null;
}

export interface DeviceListResponse {
  devices: DeviceSummary[];
}

export interface HeartbeatResponse {
  lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Sync roots  —  GET/POST /api/roots
// ---------------------------------------------------------------------------

export interface SyncRootSummary {
  id: string;
  name: string;
  /** Per-root logical clock (SPEC §7). */
  seq: number;
  createdAt: number;
}

export interface CreateRootRequest {
  name: string;
}

export interface RootListResponse {
  roots: SyncRootSummary[];
}

// ---------------------------------------------------------------------------
// Delta pull  —  GET /api/roots/:id/changes?since=<seq>
// ---------------------------------------------------------------------------

export interface ChangesResponse {
  /** The new cursor: apply changes, then advance the local cursor to this. */
  seq: number;
  /** Files changed since the requested `since` cursor, with their manifests. */
  changes: VersionManifest[];
}

// ---------------------------------------------------------------------------
// Commit  —  POST /api/roots/:id/commit
// ---------------------------------------------------------------------------

export interface CommitRequest {
  /** The cursor the client committed against, for conflict detection (SPEC §7). */
  baseSeq: number;
  versions: VersionManifest[];
}

export interface CommitResponse {
  /** New root `seq` after applying. The client advances its cursor to this. */
  seq: number;
  /**
   * Paths that became conflict copies under last-write-wins (SPEC §7). Empty on
   * a clean commit. Use {@link conflictCopyName} to render the losing copy.
   */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// Chunk transfer  —  POST /api/chunks/check  ·  POST /api/chunks/download
// ---------------------------------------------------------------------------

export interface ChunkCheckRequest {
  hashes: string[];
}

export interface ChunkCheckResponse {
  /** Subset of requested hashes not already in R2, each with a presigned PUT URL. */
  missing: { hash: string; uploadUrl: string }[];
}

export interface ChunkDownloadRequest {
  hashes: string[];
}

export interface ChunkDownloadResponse {
  /** Presigned GET URLs for the requested chunks. */
  urls: { hash: string; downloadUrl: string }[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Uniform error envelope returned by the API on non-2xx responses. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, safe on both sides)
// ---------------------------------------------------------------------------

/**
 * Normalize a path to the POSIX, root-relative form used on the wire: backslashes
 * to forward slashes, collapsed duplicate slashes, no leading `./` or `/`.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Build the conflict-copy filename for a losing last-write-wins side (SPEC §7):
 * `name (conflicted copy from <device>, <date>).ext`. Operates on the basename;
 * the caller rejoins it with the directory.
 */
export function conflictCopyName(fileName: string, deviceName: string, date: Date): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const stamp = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${stem} (conflicted copy from ${deviceName}, ${stamp})${ext}`;
}
