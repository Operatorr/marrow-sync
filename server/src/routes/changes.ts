// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Delta + commit routes (SPEC §7):
 *   GET  /roots/:id/changes?since=<seq>  → { seq, changes: VersionManifest[] }
 *   POST /roots/:id/commit               CommitRequest → { seq, conflicts }
 *
 * Mounted under `/api`.
 *
 * `changes` returns every file in the root whose `updated_seq` is newer than the
 * caller's cursor, with the current version's chunk manifest, plus the root's
 * current `seq` as the new cursor.
 *
 * `commit` applies a batch of new versions atomically against the root's logical
 * clock: it bumps `sync_root.seq`, and for each version writes `file_version` +
 * `file_chunk`, repoints `file.current_version_id`, stamps `file.updated_seq`,
 * and increments `chunk.refcount`. When a path is superseded or tombstoned the
 * prior current version's chunk refcounts are decremented in the same batch so
 * the count tracks live references for GC (SPEC §6). Conflict detection is
 * last-write-wins: if a file changed at a `seq` newer than the committer's
 * `baseSeq`, the committer still wins the head pointer but the path is reported
 * in `conflicts` so the other device can keep a conflict copy (SPEC §7).
 *
 * Referenced chunks are verified to exist in R2 (a `HEAD` against the bucket) the
 * first time this user commits a hash; only then is the per-user `chunk` row
 * created. This guarantees a committed `file_chunk` never points at absent bytes
 * (SPEC §7 upload flow step 4 — R2 existence, not a speculative row).
 */

import {
  type ChangesResponse,
  type CommitRequest,
  type CommitResponse,
  normalizePath,
} from "@marrow/shared";
import { zValidator } from "@hono/zod-validator";
import { type BatchItem } from "drizzle-orm/batch";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDb, type Db } from "../db/client";
import { chunk, file, fileChunk, fileVersion, syncRoot } from "../db/schema";
import { type AppBindings } from "../env";
import { bump, isConflict, parseSince } from "../lib/clock";
import { collectChunkHashes, groupChunks, toManifest } from "../lib/manifest";
import { chunkKey } from "../lib/r2";
import { errors } from "../middleware/error";

const idParamSchema = z.object({ id: z.string().min(1) });
const sinceQuerySchema = z.object({ since: z.string().optional() });

const versionManifestSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  mode: z.number().int().optional(),
  chunks: z.array(z.string().min(1)),
  deleted: z.boolean().optional(),
});

const commitSchema = z
  .object({
    baseSeq: z.number().int().nonnegative(),
    versions: z.array(versionManifestSchema).min(1),
  })
  // Two manifests whose paths normalize to the same value would race to UPDATE
  // the same `file` row / violate UNIQUE(sync_root_id, path) in one batch. Reject
  // the whole commit so the client resends a de-duplicated manifest (SPEC §7).
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.versions.forEach((v, i) => {
      const norm = normalizePath(v.path);
      if (seen.has(norm)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate path in commit: ${norm}`,
          path: ["versions", i, "path"],
        });
      }
      seen.add(norm);
    });
  });

/** Load a root owned by `userId`, or throw 404. */
async function loadOwnedRoot(db: Db, rootId: string, userId: string) {
  const [root] = await db
    .select({ id: syncRoot.id, seq: syncRoot.seq })
    .from(syncRoot)
    .where(and(eq(syncRoot.id, rootId), eq(syncRoot.userId, userId)))
    .limit(1);
  if (!root) throw errors.notFound("Sync root not found");
  return root;
}

export const changes = new Hono<AppBindings>()
  .get(
    "/:id/changes",
    zValidator("param", idParamSchema),
    zValidator("query", sinceQuerySchema),
    async (c) => {
      const { id: rootId } = c.req.valid("param");
      const since = parseSince(c.req.valid("query").since);
      const userId = c.get("userId");
      const db = createDb(c.env.DB);

      const root = await loadOwnedRoot(db, rootId, userId);

      const changedFiles = await db
        .select({
          id: file.id,
          path: file.path,
          deleted: file.deleted,
          currentVersionId: file.currentVersionId,
        })
        .from(file)
        .where(and(eq(file.syncRootId, rootId), gt(file.updatedSeq, since)));

      const versionIds = changedFiles
        .map((f) => f.currentVersionId)
        .filter((v): v is string => v !== null);

      const versionRows = versionIds.length
        ? await db
            .select({
              id: fileVersion.id,
              size: fileVersion.size,
              mtime: fileVersion.mtime,
              mode: fileVersion.mode,
            })
            .from(fileVersion)
            .where(inArray(fileVersion.id, versionIds))
        : [];
      const versionById = new Map(versionRows.map((v) => [v.id, v]));

      const chunkRows = versionIds.length
        ? await db
            .select({
              versionId: fileChunk.versionId,
              idx: fileChunk.idx,
              chunkHash: fileChunk.chunkHash,
            })
            .from(fileChunk)
            .where(inArray(fileChunk.versionId, versionIds))
        : [];
      const chunksByVersion = groupChunks(chunkRows);

      const changesOut = changedFiles.map((f) => {
        const v = f.currentVersionId ? versionById.get(f.currentVersionId) : undefined;
        return toManifest({
          path: f.path,
          deleted: f.deleted,
          size: v?.size ?? null,
          mtime: v?.mtime ?? null,
          mode: v?.mode ?? null,
          chunks: f.currentVersionId ? (chunksByVersion.get(f.currentVersionId) ?? []) : [],
        });
      });

      const body: ChangesResponse = { seq: root.seq, changes: changesOut };
      return c.json(body);
    },
  )
  .post(
    "/:id/commit",
    zValidator("param", idParamSchema),
    zValidator("json", commitSchema),
    async (c) => {
      const { id: rootId } = c.req.valid("param");
      const payload = c.req.valid("json") satisfies CommitRequest;
      const userId = c.get("userId");
      const deviceId = c.get("deviceId");
      const db = createDb(c.env.DB);

      // Only a registered device may write content (it is `file_version.created_by`).
      if (!deviceId) throw errors.forbidden("Commit requires a device token");

      const root = await loadOwnedRoot(db, rootId, userId);

      // Resolve every referenced chunk to a row this user owns. A chunk already
      // recorded for the user is trusted (its bytes were HEAD-verified when first
      // committed). For the rest we HEAD R2 directly: only an object actually
      // present in the bucket is accepted and gets a `chunk` row created below.
      // This closes the gap where a client could `check` then `commit` while
      // skipping the upload (SPEC §7 upload flow step 4).
      const referenced = collectChunkHashes(payload.versions);
      const newChunkRows: { hash: string; size: number }[] = [];
      if (referenced.length) {
        const existingChunks = await db
          .select({ hash: chunk.hash })
          .from(chunk)
          .where(and(eq(chunk.userId, userId), inArray(chunk.hash, referenced)));
        const ownedSet = new Set(existingChunks.map((r) => r.hash));
        const toVerify = referenced.filter((h) => !ownedSet.has(h));

        const heads = await Promise.all(
          toVerify.map((hash) => c.env.BUCKET.head(chunkKey(userId, hash))),
        );
        const absent: string[] = [];
        toVerify.forEach((hash, idx) => {
          const head = heads[idx];
          if (head) {
            // R2 reports the authoritative byte length; trust it over client hints.
            newChunkRows.push({ hash, size: head.size });
          } else {
            absent.push(hash);
          }
        });
        if (absent.length) {
          throw errors.badRequest(
            `Commit references ${absent.length} chunk(s) not uploaded to storage`,
          );
        }
      }

      // Snapshot existing files at the committed paths to detect conflicts, decide
      // INSERT vs UPDATE for the head, and read the prior current version so its
      // chunk refcounts can be decremented when superseded (SPEC §6 GC).
      const paths = payload.versions.map((v) => normalizePath(v.path));
      const existing = paths.length
        ? await db
            .select({
              id: file.id,
              path: file.path,
              updatedSeq: file.updatedSeq,
              currentVersionId: file.currentVersionId,
            })
            .from(file)
            .where(and(eq(file.syncRootId, rootId), inArray(file.path, paths)))
        : [];
      const existingByPath = new Map(existing.map((e) => [e.path, e]));

      // Prior current-version chunk hashes per file, for refcount decrement on
      // supersede/tombstone. Indexed by `currentVersionId`.
      const priorVersionIds = existing
        .map((e) => e.currentVersionId)
        .filter((v): v is string => v !== null);
      const priorChunkRows = priorVersionIds.length
        ? await db
            .select({ versionId: fileChunk.versionId, chunkHash: fileChunk.chunkHash })
            .from(fileChunk)
            .where(inArray(fileChunk.versionId, priorVersionIds))
        : [];
      const priorChunksByVersion = new Map<string, string[]>();
      for (const r of priorChunkRows) {
        const list = priorChunksByVersion.get(r.versionId) ?? [];
        list.push(r.chunkHash);
        priorChunksByVersion.set(r.versionId, list);
      }

      const newSeq = bump(root.seq);
      const now = Date.now();
      const conflicts: string[] = [];

      // Build the atomic batch: bump seq, then per-version writes. D1 `batch`
      // executes the statements in one implicit transaction.
      const statements: BatchItem<"sqlite">[] = [
        db.update(syncRoot).set({ seq: newSeq }).where(eq(syncRoot.id, rootId)),
      ];

      // Create the per-user chunk rows for HEAD-verified uploads first, so the
      // file_chunk FKs below resolve. refcount starts at 0 and is bumped per
      // referencing file_chunk row in the version loop.
      for (const row of newChunkRows) {
        statements.push(
          db
            .insert(chunk)
            .values({ hash: row.hash, size: row.size, userId, refcount: 0 })
            .onConflictDoNothing(),
        );
      }

      // Decrement refcounts on a prior current version's chunks when it is
      // superseded or tombstoned (SPEC §6 — refcount tracks live references; a
      // GC job collects rows + R2 objects at refcount 0).
      const decrementPriorChunks = (priorVersionId: string | null) => {
        if (!priorVersionId) return;
        for (const hash of priorChunksByVersion.get(priorVersionId) ?? []) {
          statements.push(
            db
              .update(chunk)
              .set({ refcount: sql`max(${chunk.refcount} - 1, 0)` })
              .where(and(eq(chunk.hash, hash), eq(chunk.userId, userId))),
          );
        }
      };

      for (let i = 0; i < payload.versions.length; i++) {
        const manifest = payload.versions[i]!;
        const path = paths[i]!;
        const prior = existingByPath.get(path);

        // Last-write-wins: a path changed since the committer's base is a conflict,
        // but the committer still wins the head pointer (SPEC §7).
        if (prior && isConflict(prior.updatedSeq, payload.baseSeq)) {
          conflicts.push(path);
        }

        const fileId = prior?.id ?? crypto.randomUUID();
        const isDeleted = manifest.deleted === true;

        if (isDeleted) {
          // Tombstone: no new version rows; just flip the head + stamp the cursor.
          if (prior) {
            // The superseded head's chunks lose their live reference.
            decrementPriorChunks(prior.currentVersionId);
            statements.push(
              db
                .update(file)
                .set({ deleted: 1, currentVersionId: null, updatedSeq: newSeq })
                .where(eq(file.id, fileId)),
            );
          } else {
            statements.push(
              db.insert(file).values({
                id: fileId,
                syncRootId: rootId,
                path,
                currentVersionId: null,
                deleted: 1,
                updatedSeq: newSeq,
              }),
            );
          }
          continue;
        }

        const versionId = crypto.randomUUID();

        // Upsert the file head first so file_version's FK is satisfiable, then
        // version + chunk rows, then repoint the head at the new version.
        if (prior) {
          // The about-to-be-superseded head's chunks lose their live reference.
          decrementPriorChunks(prior.currentVersionId);
          statements.push(db.update(file).set({ deleted: 0 }).where(eq(file.id, fileId)));
        } else {
          statements.push(
            db.insert(file).values({
              id: fileId,
              syncRootId: rootId,
              path,
              currentVersionId: null,
              deleted: 0,
              updatedSeq: newSeq,
            }),
          );
        }

        statements.push(
          db.insert(fileVersion).values({
            id: versionId,
            fileId,
            size: manifest.size,
            mtime: manifest.mtime,
            mode: manifest.mode ?? null,
            createdAt: now,
            createdBy: deviceId,
          }),
        );

        manifest.chunks.forEach((hash, idx) => {
          statements.push(db.insert(fileChunk).values({ versionId, idx, userId, chunkHash: hash }));
          // Each new file_chunk row references a chunk → bump its refcount (SPEC §6).
          statements.push(
            db
              .update(chunk)
              .set({ refcount: sql`${chunk.refcount} + 1` })
              .where(and(eq(chunk.hash, hash), eq(chunk.userId, userId))),
          );
        });

        statements.push(
          db
            .update(file)
            .set({ currentVersionId: versionId, deleted: 0, updatedSeq: newSeq })
            .where(eq(file.id, fileId)),
        );
      }

      // D1 requires a non-empty tuple for batch(); the seq bump guarantees one.
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

      const body: CommitResponse = { seq: newSeq, conflicts };
      return c.json(body);
    },
  );
