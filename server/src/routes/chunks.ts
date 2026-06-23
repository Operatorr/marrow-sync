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

import { createDb } from "../db/client";
import { chunk } from "../db/schema";
import { type AppBindings } from "../env";
import { selectInChunks } from "../lib/d1";
import { presignGet, presignPut } from "../lib/r2";

const hashesSchema = z.object({
  hashes: z.array(z.string().min(1)).max(10_000),
});

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
    // Chunked to stay under D1's per-query bound-parameter limit (SPEC §7).
    const present = await selectInChunks(unique, (slice) =>
      db
        .select({ hash: chunk.hash })
        .from(chunk)
        .where(and(eq(chunk.userId, userId), inArray(chunk.hash, slice))),
    );
    const presentSet = new Set(present.map((r) => r.hash));
    const missingHashes = unique.filter((h) => !presentSet.has(h));

    const missing = await Promise.all(
      missingHashes.map(async (hash) => ({
        hash,
        uploadUrl: await presignPut(c.env, userId, hash),
      })),
    );

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

    // Only presign GETs for chunks this user actually owns — never mint URLs for
    // hashes absent from the caller's manifest history (ownership filter, SPEC §6).
    // Chunked to stay under D1's per-query bound-parameter limit (SPEC §7).
    const owned = await selectInChunks(unique, (slice) =>
      db
        .select({ hash: chunk.hash })
        .from(chunk)
        .where(and(eq(chunk.userId, userId), inArray(chunk.hash, slice))),
    );
    const ownedHashes = owned.map((r) => r.hash);

    const urls = await Promise.all(
      ownedHashes.map(async (hash) => ({
        hash,
        downloadUrl: await presignGet(c.env, userId, hash),
      })),
    );

    const body: ChunkDownloadResponse = { urls };
    return c.json(body);
  });
