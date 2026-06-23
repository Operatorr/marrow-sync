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

/**
 * Parse a `?since=` cursor query value into a non-negative integer, defaulting to
 * 0. Only a plain run of digits is accepted — this rejects `Number()` quirks like
 * `"1e3"` (→ 1000) and `"0x10"` (→ 16) that would silently shift the cursor. A
 * value beyond `Number.MAX_SAFE_INTEGER` (which `Number()` would round) also
 * falls back to 0 rather than returning an imprecise cursor.
 */
export function parseSince(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}
