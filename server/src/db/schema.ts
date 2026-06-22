// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drizzle schema for Cloudflare D1 (SPEC §6).
 *
 * Two groups of tables:
 *   1. better-auth core tables (`user`, `session`, `account`, `verification`) —
 *      shapes mirror better-auth's SQLite/Drizzle adapter exactly so the adapter
 *      can read/write them and `drizzle-kit` can generate their migration. Do not
 *      hand-edit their rows; better-auth owns them.
 *   2. Marrow domain tables (`device`, `sync_root`, `file`, `file_version`,
 *      `file_chunk`, `chunk`) — every row owned by a single `user_id`. No
 *      sharing/membership/ACL tables exist by design (SPEC §11).
 */

import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// better-auth core tables (managed by better-auth; see SPEC §6/§10)
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Marrow domain tables (SPEC §6). Timestamps stored as plain epoch-ms integers.
// ---------------------------------------------------------------------------

/** A registered installation of the client — the real unit of auth (SPEC §10). */
export const device = sqliteTable(
  "device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    /** sha-256 hex of the device token. The raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
  },
  (table) => [
    index("device_user_id_idx").on(table.userId),
    index("device_token_hash_idx").on(table.tokenHash),
  ],
);

/** A folder the user syncs. Carries the per-root logical clock (SPEC §7). */
export const syncRoot = sqliteTable(
  "sync_root",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    seq: integer("seq").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("sync_root_user_id_idx").on(table.userId)],
);

/** Logical file at a path within a root. Mutable head pointer (SPEC §6). */
export const file = sqliteTable(
  "file",
  {
    id: text("id").primaryKey(),
    syncRootId: text("sync_root_id")
      .notNull()
      .references(() => syncRoot.id, { onDelete: "cascade" }),
    /** POSIX-normalized, relative to the root. */
    path: text("path").notNull(),
    currentVersionId: text("current_version_id"),
    /** Tombstone: 1 when the path is deleted. */
    deleted: integer("deleted").notNull().default(0),
    /** root.seq at the last change to this file (the delta cursor). */
    updatedSeq: integer("updated_seq").notNull(),
  },
  (table) => [
    unique("file_root_path_unq").on(table.syncRootId, table.path),
    index("file_root_seq_idx").on(table.syncRootId, table.updatedSeq),
  ],
);

/** Immutable snapshot of a file's content + metadata (SPEC §6). */
export const fileVersion = sqliteTable(
  "file_version",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    size: integer("size").notNull(),
    mtime: integer("mtime").notNull(),
    /** Unix permission bits (executable, etc.); null where unavailable. */
    mode: integer("mode"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => device.id),
  },
  (table) => [index("file_version_file_id_idx").on(table.fileId)],
);

/** Content-addressed blob: one row per unique chunk per user (SPEC §6). */
export const chunk = sqliteTable(
  "chunk",
  {
    /** BLAKE3 hex of the plaintext chunk; also the R2 object key. */
    hash: text("hash").notNull(),
    size: integer("size").notNull(),
    /** Owning user — dedup/isolation scope is per-user (SPEC §6). */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Number of file_chunk rows referencing this chunk (for GC, SPEC §6). */
    refcount: integer("refcount").notNull().default(0),
  },
  // Composite PK: the same content hash may exist once per user (SPEC §6).
  (table) => [primaryKey({ columns: [table.userId, table.hash] })],
);

/** Ordered chunk list for a version — the file's "recipe" (SPEC §6). */
export const fileChunk = sqliteTable(
  "file_chunk",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => fileVersion.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** Owning user, carried so the FK can target chunk's composite PK. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chunkHash: text("chunk_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.idx] }),
    // FK to the per-user chunk identity (SPEC §6 per-user dedup).
    foreignKey({
      columns: [table.userId, table.chunkHash],
      foreignColumns: [chunk.userId, chunk.hash],
    }),
  ],
);

/** The full schema object, handed to the drizzle adapter + drizzle() factory. */
export const schema = {
  user,
  session,
  account,
  verification,
  device,
  syncRoot,
  file,
  fileVersion,
  fileChunk,
  chunk,
};
