// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cloudflare D1 query-shaping helpers (SPEC §7).
 *
 * D1 caps the number of bound parameters per query (documented at 100). An
 * `inArray(col, values)` binds one parameter per element, so a lookup over a
 * large list — `chunks/check` and `chunks/download` accept up to 10_000 hashes,
 * and a first-sync `commit`/`changes` can touch thousands of versions — would
 * blow that limit and fail. {@link selectInChunks} splits such lookups into
 * param-safe sub-queries and recombines the rows.
 */

/**
 * Max elements fed into a single `inArray()`. Kept comfortably under D1's
 * per-query bound-parameter cap (100) so the other params in the same WHERE
 * clause (userId, rootId, …) still fit.
 */
export const IN_ARRAY_CHUNK = 80;

/** Split `items` into consecutive slices of at most `size` (default {@link IN_ARRAY_CHUNK}). */
export function chunkArray<T>(items: readonly T[], size: number = IN_ARRAY_CHUNK): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run an `inArray`-style SELECT in param-safe sub-batches and concatenate the
 * rows. `query` receives one slice of `values` at a time; empty input short-
 * circuits to `[]` with no query issued. Order across slices is not guaranteed —
 * callers that need ordering must sort the combined result. Duplicate input
 * values are NOT de-duplicated; callers that care must pre-dedupe.
 */
export async function selectInChunks<T, R>(
  values: readonly T[],
  query: (slice: T[]) => Promise<R[]>,
  size: number = IN_ARRAY_CHUNK,
): Promise<R[]> {
  if (size < 1) throw new Error("chunk size must be >= 1");
  if (values.length === 0) return [];
  const slices = chunkArray(values, size);
  const results = await Promise.all(slices.map((slice) => query(slice)));
  return results.flat();
}
