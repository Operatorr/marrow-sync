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
 * current `seq` as the new cursor. The `since` cursor is EXCLUSIVE (the query is
 * `updated_seq > since`); a client applies the response, then passes the returned
 * `seq` back as the next `since` — it must not add 1 itself.
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
  hasTraversal,
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
import { selectInChunks } from "../lib/d1";
import { isConflict, parseSince } from "../lib/clock";
import { collectChunkHashes, groupChunks, toManifest } from "../lib/manifest";
import { chunkKey } from "../lib/r2";
import { errors } from "../middleware/error";

const idParamSchema = z.object({ id: z.string().min(1) });
const sinceQuerySchema = z.object({ since: z.string().optional() });

/**
 * A commit is applied as one atomic D1 batch (seq bump + per-version writes +
 * per-chunk insert/refcount). D1 bounds the size of a batch, so these caps keep a
 * single commit well inside that envelope; a first sync of a very large tree must
 * be split across multiple commits by the client, each independently atomic and
 * each advancing the cursor (SPEC §7).
 */
const MAX_COMMIT_VERSIONS = 1000;
const MAX_COMMIT_CHUNK_REFS = 5000;

/** BLAKE3 content-address: 64 lowercase hex chars (SPEC §9, `HASH_ALGORITHM`). */
const chunkHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a 64-char lowercase hex hash");

export const versionManifestSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    mtime: z.number().int().nonnegative(),
    mode: z.number().int().optional(),
    chunks: z.array(chunkHashSchema),
    deleted: z.boolean().optional(),
  })
  // Preserve the chunker's invariant that a live file has ≥1 chunk and a tombstone
  // has none — rejects a `deleted:false, chunks:[], size>0` manifest that would
  // otherwise create a zero-chunk, nonzero-size version (SPEC §9). The chunker
  // emits one empty chunk for a zero-byte file, so "live ⇒ ≥1 chunk" holds.
  .superRefine((v, ctx) => {
    if (v.deleted === true) {
      if (v.chunks.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A deleted version must carry no chunks",
          path: ["chunks"],
        });
      }
    } else if (v.chunks.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A live version must reference at least one chunk",
        path: ["chunks"],
      });
    }
  });

export const commitSchema = z
  .object({
    baseSeq: z.number().int().nonnegative(),
    versions: z.array(versionManifestSchema).min(1).max(MAX_COMMIT_VERSIONS),
  })
  .superRefine((data, ctx) => {
    // Two manifests whose paths normalize to the same value would race to UPDATE
    // the same `file` row / violate UNIQUE(sync_root_id, path) in one batch; a
    // `..` segment is a directory-traversal attempt against the (TODO) write path.
    // Reject either so the client resends a clean, de-duplicated manifest (SPEC §7/§9).
    const seen = new Set<string>();
    let chunkRefs = 0;
    data.versions.forEach((v, i) => {
      chunkRefs += v.chunks.length;
      if (hasTraversal(v.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Path escapes the sync root: ${v.path}`,
          path: ["versions", i, "path"],
        });
      }
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
    // Bound total chunk references so the atomic batch stays inside D1's limits.
    if (chunkRefs > MAX_COMMIT_CHUNK_REFS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Commit references ${chunkRefs} chunks; split into commits of ≤ ${MAX_COMMIT_CHUNK_REFS}`,
        path: ["versions"],
      });
    }
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

      // TODO(marrow): this returns every changed file with full manifests in one
      // response — fine for incremental deltas but unbounded for a `since=0` first
      // pull of a large root (Worker memory/response-size limits). Add a seq-paged
      // cursor (LIMIT + a `hasMore`/next-`since`) before large roots are real (SPEC §7).
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

      // Chunked to stay under D1's per-query bound-parameter limit when a large
      // first-sync delta touches thousands of versions (SPEC §7).
      const versionRows = await selectInChunks(versionIds, (slice) =>
        db
          .select({
            id: fileVersion.id,
            size: fileVersion.size,
            mtime: fileVersion.mtime,
            mode: fileVersion.mode,
          })
          .from(fileVersion)
          .where(inArray(fileVersion.id, slice)),
      );
      const versionById = new Map(versionRows.map((v) => [v.id, v]));

      const chunkRows = await selectInChunks(versionIds, (slice) =>
        db
          .select({
            versionId: fileChunk.versionId,
            idx: fileChunk.idx,
            chunkHash: fileChunk.chunkHash,
          })
          .from(fileChunk)
          .where(inArray(fileChunk.versionId, slice)),
      );
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

      // Ownership/existence gate (throws 404). The cursor is allocated atomically
      // inside the batch below, not from this read, to avoid a lost-update race.
      await loadOwnedRoot(db, rootId, userId);

      // Resolve every referenced chunk to a row this user owns. A chunk already
      // recorded for the user is trusted (its bytes were HEAD-verified when first
      // committed). For the rest we HEAD R2 directly: only an object actually
      // present in the bucket is accepted and gets a `chunk` row created below.
      // This closes the gap where a client could `check` then `commit` while
      // skipping the upload (SPEC §7 upload flow step 4).
      const referenced = collectChunkHashes(payload.versions);
      const newChunkRows: { hash: string; size: number }[] = [];
      if (referenced.length) {
        // Chunked to stay under D1's per-query bound-parameter limit (SPEC §7).
        const existingChunks = await selectInChunks(referenced, (slice) =>
          db
            .select({ hash: chunk.hash })
            .from(chunk)
            .where(and(eq(chunk.userId, userId), inArray(chunk.hash, slice))),
        );
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
      // Chunked to stay under D1's per-query bound-parameter limit (SPEC §7).
      const existing = await selectInChunks(paths, (slice) =>
        db
          .select({
            id: file.id,
            path: file.path,
            updatedSeq: file.updatedSeq,
            currentVersionId: file.currentVersionId,
          })
          .from(file)
          .where(and(eq(file.syncRootId, rootId), inArray(file.path, slice))),
      );
      const existingByPath = new Map(existing.map((e) => [e.path, e]));

      // Prior current-version chunk hashes per file, for refcount decrement on
      // supersede/tombstone. Indexed by `currentVersionId`.
      const priorVersionIds = existing
        .map((e) => e.currentVersionId)
        .filter((v): v is string => v !== null);
      const priorChunkRows = await selectInChunks(priorVersionIds, (slice) =>
        db
          .select({ versionId: fileChunk.versionId, chunkHash: fileChunk.chunkHash })
          .from(fileChunk)
          .where(inArray(fileChunk.versionId, slice)),
      );
      const priorChunksByVersion = new Map<string, string[]>();
      for (const r of priorChunkRows) {
        const list = priorChunksByVersion.get(r.versionId) ?? [];
        list.push(r.chunkHash);
        priorChunksByVersion.set(r.versionId, list);
      }

      const now = Date.now();
      const conflicts: string[] = [];

      // Allocate the new cursor ATOMICALLY rather than from the stale JS read:
      // increment `seq` in SQL as the first statement of the batch, and stamp every
      // file row via a scalar subquery that reads the just-incremented value. Both
      // run inside D1's single batch transaction, so two devices committing the
      // same root concurrently get distinct, monotonic cursors — no lost increment
      // and no two commits collapsing onto one `seq` (SPEC §7). The allocated value
      // is read back from the increment's RETURNING for the response cursor.
      const seqExpr = sql<number>`(select ${syncRoot.seq} from ${syncRoot} where ${syncRoot.id} = ${rootId})`;
      const statements: BatchItem<"sqlite">[] = [
        db
          .update(syncRoot)
          .set({ seq: sql`${syncRoot.seq} + 1` })
          .where(eq(syncRoot.id, rootId))
          .returning({ seq: syncRoot.seq }),
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

      // Accumulate the NET refcount change per hash across the whole commit, then
      // emit ONE update per hash after the loop. Doing it per-reference with an
      // asymmetric `max(refcount-1, 0)` floor made the result order-dependent when
      // a hash was both added and superseded in the same batch, which could leave a
      // count permanently inflated (chunks never reach 0 → GC leak). A single net
      // `max(refcount + delta, 0)` per hash is order-independent (SPEC §6).
      const refcountDelta = new Map<string, number>();
      const addDelta = (hash: string, n: number) =>
        refcountDelta.set(hash, (refcountDelta.get(hash) ?? 0) + n);
      // A superseded/tombstoned prior version's chunks each lose one live reference.
      const releasePriorChunks = (priorVersionId: string | null) => {
        if (!priorVersionId) return;
        for (const hash of priorChunksByVersion.get(priorVersionId) ?? []) addDelta(hash, -1);
      };

      for (let i = 0; i < payload.versions.length; i++) {
        const manifest = payload.versions[i]!;
        const path = paths[i]!;
        const prior = existingByPath.get(path);

        // Last-write-wins: a path changed since the committer's base is a conflict,
        // but the committer still wins the head pointer (SPEC §7).
        // TODO(marrow): the conflict copy must be made on the *losing* device,
        // which isn't this committer — its divergent local file never reached the
        // server, so this list is only advisory to the winner. Fully wiring the
        // conflict-copy mechanism (signal the loser on its next pull) is deferred.
        if (prior && isConflict(prior.updatedSeq, payload.baseSeq)) {
          conflicts.push(path);
        }

        const fileId = prior?.id ?? crypto.randomUUID();
        const isDeleted = manifest.deleted === true;

        if (isDeleted) {
          // Tombstone: no new version rows; just flip the head + stamp the cursor.
          if (prior) {
            // The superseded head's chunks lose their live reference.
            releasePriorChunks(prior.currentVersionId);
            statements.push(
              db
                .update(file)
                .set({ deleted: 1, currentVersionId: null, updatedSeq: seqExpr })
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
                updatedSeq: seqExpr,
              }),
            );
          }
          continue;
        }

        const versionId = crypto.randomUUID();

        // For an existing path the file row is already present and the final head
        // update below stamps deleted:0/cursor — no intermediate update needed. For
        // a new path, insert the head first so file_version's FK is satisfiable.
        if (prior) {
          // The about-to-be-superseded head's chunks lose their live reference.
          releasePriorChunks(prior.currentVersionId);
        } else {
          statements.push(
            db.insert(file).values({
              id: fileId,
              syncRootId: rootId,
              path,
              currentVersionId: null,
              deleted: 0,
              updatedSeq: seqExpr,
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
          // Each new file_chunk row references a chunk → +1 live reference (SPEC §6).
          addDelta(hash, 1);
        });

        statements.push(
          db
            .update(file)
            .set({ currentVersionId: versionId, deleted: 0, updatedSeq: seqExpr })
            .where(eq(file.id, fileId)),
        );
      }

      // One net refcount update per touched hash (order-independent; skips no-ops).
      for (const [hash, delta] of refcountDelta) {
        if (delta === 0) continue;
        statements.push(
          db
            .update(chunk)
            .set({ refcount: sql`max(${chunk.refcount} + ${delta}, 0)` })
            .where(and(eq(chunk.hash, hash), eq(chunk.userId, userId))),
        );
      }

      // D1 requires a non-empty tuple for batch(); the seq bump guarantees one.
      const result = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      // The first statement is the atomic seq bump; its RETURNING row carries the
      // cursor this commit was allocated. A missing row means the root vanished
      // between the ownership check and the batch (concurrent delete) → 404.
      const seqRow = (result[0] as unknown as { seq: number }[] | undefined)?.[0];
      if (!seqRow) throw errors.notFound("Sync root not found");
      const newSeq = seqRow.seq;

      const body: CommitResponse = { seq: newSeq, conflicts };
      return c.json(body);
    },
  );
