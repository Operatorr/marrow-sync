// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure helpers for assembling change/commit results (SPEC §7), kept free of D1
 * so they're directly unit-testable.
 */

import { type VersionManifest } from "@marrow/shared";

/** A `file` row plus its current version's metadata and ordered chunk hashes. */
export interface FileWithVersion {
  path: string;
  deleted: number;
  size: number | null;
  mtime: number | null;
  mode: number | null;
  chunks: string[];
}

/** Project a DB file+version row into the wire {@link VersionManifest}. */
export function toManifest(row: FileWithVersion): VersionManifest {
  if (row.deleted) {
    return { path: row.path, size: 0, mtime: row.mtime ?? 0, chunks: [], deleted: true };
  }
  const manifest: VersionManifest = {
    path: row.path,
    size: row.size ?? 0,
    mtime: row.mtime ?? 0,
    chunks: row.chunks,
  };
  if (row.mode !== null) manifest.mode = row.mode;
  return manifest;
}

/** Group `(versionId, idx, chunkHash)` rows into ordered hash lists per version. */
export function groupChunks(
  rows: { versionId: string; idx: number; chunkHash: string }[],
): Map<string, string[]> {
  const byVersion = new Map<string, { idx: number; hash: string }[]>();
  for (const r of rows) {
    const list = byVersion.get(r.versionId) ?? [];
    list.push({ idx: r.idx, hash: r.chunkHash });
    byVersion.set(r.versionId, list);
  }
  const ordered = new Map<string, string[]>();
  for (const [versionId, list] of byVersion) {
    ordered.set(
      versionId,
      list.sort((a, b) => a.idx - b.idx).map((e) => e.hash),
    );
  }
  return ordered;
}

/** Deduplicated set of every chunk hash referenced across the given manifests. */
export function collectChunkHashes(versions: VersionManifest[]): string[] {
  const set = new Set<string>();
  for (const v of versions) for (const h of v.chunks) set.add(h);
  return [...set];
}
