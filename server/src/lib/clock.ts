// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-root logical sequence helpers (SPEC §7).
 *
 * Each `sync_root` carries a monotonically increasing `seq`. Every mutation bumps
 * it and stamps the affected `file` rows so clients can pull deltas with
 * `?since=<seq>`. These are pure helpers over a current `seq` value; the actual
 * read/write of `sync_root.seq` happens transactionally in the commit route.
 */

/** The next sequence value after `current` (the first mutation produces 1). */
export function bump(current: number): number {
  return current + 1;
}

/**
 * Whether a committed file is in conflict: it changed at a `seq` strictly newer
 * than the cursor the committer based their work on (SPEC §7, last-write-wins).
 */
export function isConflict(fileUpdatedSeq: number, baseSeq: number): boolean {
  return fileUpdatedSeq > baseSeq;
}

/** Parse a `?since=` cursor query value into a non-negative integer, defaulting to 0. */
export function parseSince(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
