// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chunk transfer routes (SPEC §7/§9). The Worker never proxies bytes — it only
 * brokers presigned R2 URLs:
 *   POST /chunks/check     { hashes } → { missing: [{ hash, uploadUrl }] }
 *   POST /chunks/download  { hashes } → { urls:    [{ hash, downloadUrl }] }
 *
 * Mounted under `/api`.
 *
 * `check` returns the subset of hashes NOT already stored for this user, each
 * with a presigned PUT URL. It does NOT pre-register `chunk` rows: the row is
 * created at commit time only after the bytes are confirmed present in R2, so a
 * client that calls `check` but skips the upload cannot later commit a dangling
 * reference (SPEC §7 upload flow; the server verifies R2 existence, not a
 * speculative row). Dedup is per-user (SPEC §6), so a hash present for another
 * user is still reported as missing here.
 *
 * `download` only presigns GET URLs for hashes the caller actually owns (a
 * `chunk` row exists for this user); unknown hashes are omitted from the result,
 * mirroring the ownership filter used by `check` and commit verification.
 */

import { type ChunkCheckResponse, type ChunkDownloadResponse } from "@marrow/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDb, type Db } from "../db/client";
import { chunk } from "../db/schema";
import { type AppBindings } from "../env";
import { selectInChunks } from "../lib/d1";
import { presignGet, presignPut } from "../lib/r2";

/** Max chunk hashes accepted in one check/download round (the client batches). */
const MAX_HASHES_PER_REQUEST = 1000;

/** Max presigned URLs built concurrently, to bound CPU/subrequest fan-out. */
const PRESIGN_CONCURRENCY = 16;

/** BLAKE3 content-address: 64 lowercase hex chars (SPEC §9, `HASH_ALGORITHM`). */
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a 64-char lowercase hex hash");

const hashesSchema = z.object({
  hashes: z.array(hashSchema).max(MAX_HASHES_PER_REQUEST),
});

/** Subset of `hashes` for which this user owns a committed `chunk` row (SPEC §6). */
async function findOwnedHashes(db: Db, userId: string, hashes: string[]): Promise<Set<string>> {
  const rows = await selectInChunks(hashes, (slice) =>
    db
      .select({ hash: chunk.hash })
      .from(chunk)
      .where(and(eq(chunk.userId, userId), inArray(chunk.hash, slice))),
  );
  return new Set(rows.map((r) => r.hash));
}

/** Map with bounded concurrency so a large hash list can't spawn unbounded work. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export const chunks = new Hono<AppBindings>()
  .post("/check", zValidator("json", hashesSchema), async (c) => {
    const { hashes } = c.req.valid("json");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const unique = [...new Set(hashes)];
    if (unique.length === 0) {
      return c.json({ missing: [] } satisfies ChunkCheckResponse);
    }

    // A chunk is "present" only when a committed row exists for this user; its
    // bytes are guaranteed to be in R2 because the row is written at commit time
    // after an R2 HEAD (see commit). Anything else is reported missing → upload.
    const presentSet = await findOwnedHashes(db, userId, unique);
    const missingHashes = unique.filter((h) => !presentSet.has(h));

    // Results are keyed by hash (not positional); duplicates were collapsed above.
    const missing = await mapLimit(missingHashes, PRESIGN_CONCURRENCY, async (hash) => ({
      hash,
      uploadUrl: await presignPut(c.env, userId, hash),
    }));

    const body: ChunkCheckResponse = { missing };
    return c.json(body);
  })
  .post("/download", zValidator("json", hashesSchema), async (c) => {
    const { hashes } = c.req.valid("json");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const unique = [...new Set(hashes)];
    if (unique.length === 0) {
      return c.json({ urls: [] } satisfies ChunkDownloadResponse);
    }

    // Only presign GETs for chunks this user owns (a `chunk` row exists for them).
    // Hashes without an owned row are silently omitted from `urls` — the client
    // diffs the response against its request to find them (SPEC §6).
    const ownedSet = await findOwnedHashes(db, userId, unique);
    const ownedHashes = unique.filter((h) => ownedSet.has(h));

    const urls = await mapLimit(ownedHashes, PRESIGN_CONCURRENCY, async (hash) => ({
      hash,
      downloadUrl: await presignGet(c.env, userId, hash),
    }));

    const body: ChunkDownloadResponse = { urls };
    return c.json(body);
  });
