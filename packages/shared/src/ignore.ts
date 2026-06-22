// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared vocabulary for ignore state (SPEC §8).
 *
 * The matching **engine** lives in Rust (`client/src-tauri/src/ignore.rs`). These
 * types are the contract the Rust core uses to explain a decision to the React UI
 * via a Tauri command, so the app can show _why_ a file is or isn't syncing — a
 * key trust feature for a tool touching source code.
 */

/** Which kind of rule was responsible for an ignore decision. */
export type IgnoreSourceKind =
  | "gitignore" // a .gitignore pattern (root or nested)
  | "marrowignore" // a .marrowignore pattern
  | "gitkeep" // kept because a .gitkeep forces its directory
  | "always" // unconditionally ignored (.git, .DS_Store, …)
  | "size" // excluded for exceeding MAX_FILE_SIZE
  | "none"; // no rule applied (included by default)

/** The specific rule that decided a path's inclusion. */
export interface IgnoreReason {
  kind: IgnoreSourceKind;
  /**
   * Path of the ignore file responsible, relative to the sync root (e.g.
   * `src/.gitignore`). Absent for `always`, `size`, and `none`.
   */
  file?: string;
  /** The raw glob line that matched (e.g. `dist/` or `!keep.txt`). */
  pattern?: string;
  /** Line number of {@link pattern} within {@link file}, 1-based. */
  line?: number;
}

/** Resolved ignore state for a single path, surfaced to the UI. */
export interface IgnoreDecision {
  /** POSIX path relative to the sync root. */
  path: string;
  /** Whether Marrow will sync this path. */
  included: boolean;
  /** The rule that produced {@link included}. */
  reason: IgnoreReason;
}

/** A batch of decisions, e.g. for rendering a tree view of a root. */
export interface IgnoreReport {
  rootId: string;
  decisions: IgnoreDecision[];
}
