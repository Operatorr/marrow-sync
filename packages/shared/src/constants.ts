// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Protocol + tuning constants shared by the Rust core, the Worker, and the UI.
 *
 * This file has **no runtime dependencies** on Node or browser APIs so it imports
 * cleanly into the Worker and the Vite/React bundle. The Rust core mirrors the
 * relevant values inline (e.g. `MAX_FILE_SIZE`, `ALWAYS_IGNORED` in `ignore.rs`,
 * chunk sizes in `chunker.rs`); those copies must be kept in lockstep with these.
 */

/**
 * Bumped on any wire-incompatible change to {@link "./protocol"}.
 *
 * Informational for now: there is no version handshake yet, so a mismatched
 * client and server are not rejected at runtime. Wiring this into a request
 * header + negotiation is post-MVP (SPEC §12).
 */
export const PROTOCOL_VERSION = 1 as const;

/** All API routes are mounted under this base path (see SPEC §7). */
export const API_BASE = "/api" as const;

/** Hash algorithm used for content addressing. The hash is the chunk's R2 key. */
export const HASH_ALGORITHM = "blake3" as const;

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * FastCDC content-defined chunking parameters. Source trees are dominated by many
 * small files, so the average is kept small; tune empirically (SPEC §9).
 */
export const CHUNK_SIZE = {
  /** Files below this size become a single chunk. */
  min: 16 * KIB,
  /** Target average chunk size (the FastCDC "normalization" point). */
  avg: 64 * KIB,
  /** Hard upper bound on a single chunk. */
  max: 256 * KIB,
} as const;

/**
 * Files larger than this are never synced unless explicitly re-included (SPEC §8.4).
 * Mirrored by `MAX_FILE_SIZE` in the Rust core (`ignore.rs`) — keep the two in lockstep.
 */
export const MAX_FILE_SIZE: number = 512 * MIB;

/** Ignore-control filenames Marrow honors (SPEC §8). */
export const IGNORE_FILES = {
  marrow: ".marrowignore",
  git: ".gitignore",
  keep: ".gitkeep",
} as const;

/**
 * Always-ignored entries regardless of config (SPEC §8.4). `.git` can never be
 * re-included; the rest may be overridden only by an explicit `!` in
 * `.marrowignore`. Mirrored verbatim by `ALWAYS_IGNORED` in the Rust engine
 * (`ignore.rs`); the Rust copy is authoritative for matching — keep them equal.
 */
export const ALWAYS_IGNORED = [
  ".git",
  ".DS_Store",
  "Thumbs.db",
  ".marrow", // Marrow's own local index / state directory
] as const;

/** Entries in {@link ALWAYS_IGNORED} that can never be re-included. */
export const NEVER_SYNCED = [".git"] as const;

/** Supported client platforms. */
export const PLATFORMS = ["macos", "windows", "linux"] as const;
