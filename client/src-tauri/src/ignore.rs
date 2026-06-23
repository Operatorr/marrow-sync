// SPDX-License-Identifier: AGPL-3.0-only

//! The Marrow ignore engine (SPEC §8) — the product differentiator.
//!
//! Resolution rules, in order:
//!
//! 1. **Always-ignored** entries (`.git`, `.DS_Store`, `Thumbs.db`, `.marrow`)
//!    short-circuit. `.git` can never be re-included; the rest may be re-included
//!    only by an explicit `!` negation in a `.marrowignore`.
//! 2. **`.gitkeep`** forces its containing directory to be kept; the `.gitkeep`
//!    file itself is always included.
//! 3. **Cascading `.gitignore`** (root and nested): deeper files take precedence,
//!    later lines within a file override earlier ones, `!pattern` re-includes.
//! 4. **`.marrowignore`** is layered *on top* of `.gitignore`: a path is excluded
//!    if matched by either source, but `.marrowignore` may use `!` to re-include
//!    something `.gitignore` (or the always-ignored junk list) excluded.
//! 5. **`MAX_FILE_SIZE`**: files larger than the cap are excluded unless an
//!    explicit `.marrowignore` negation re-includes them.
//!
//! The decision is returned in the exact `@marrow/shared` `IgnoreDecision` shape so
//! the React UI can explain *why* a file is or isn't syncing.

use std::path::{Component, Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use serde::{Deserialize, Serialize};

/// FastCDC/limits mirror of `@marrow/shared` `MAX_FILE_SIZE` (SPEC §8.4).
pub const MAX_FILE_SIZE: u64 = 512 * 1024 * 1024;

const GITIGNORE: &str = ".gitignore";
const MARROWIGNORE: &str = ".marrowignore";
const GITKEEP: &str = ".gitkeep";

/// Entries ignored regardless of config (SPEC §8.4).
const ALWAYS_IGNORED: [&str; 4] = [".git", ".DS_Store", "Thumbs.db", ".marrow"];
/// Entries that can never be re-included by any rule.
const NEVER_SYNCED: [&str; 1] = [".git"];

/// Which kind of rule was responsible for a decision. Serializes to the
/// `IgnoreSourceKind` string union in `@marrow/shared`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IgnoreSourceKind {
    Gitignore,
    Marrowignore,
    Gitkeep,
    Always,
    Size,
    None,
}

/// The specific rule that decided a path's inclusion — the `@marrow/shared`
/// `IgnoreReason` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreReason {
    pub kind: IgnoreSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

impl IgnoreReason {
    fn bare(kind: IgnoreSourceKind) -> Self {
        Self {
            kind,
            file: None,
            pattern: None,
            line: None,
        }
    }
}

/// Resolved ignore state for one path — the `@marrow/shared` `IgnoreDecision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreDecision {
    /// POSIX path relative to the sync root.
    pub path: String,
    pub included: bool,
    pub reason: IgnoreReason,
}

/// A single nested ignore matcher: its directory (relative to the root) plus the
/// compiled `Gitignore` and the raw lines (for line-number lookup on explain).
struct ScopedMatcher {
    /// Directory containing the ignore file, relative to the sync root ("" = root).
    dir: PathBuf,
    /// Path of the ignore file relative to the root, e.g. `src/.gitignore`.
    file_rel: String,
    gitignore: Gitignore,
    lines: Vec<String>,
}

/// The ignore engine for a single sync root. Build once per scan, reuse across
/// every path query.
pub struct IgnoreEngine {
    /// The sync-root directory the engine was built for. Read by the test-only
    /// `root()` accessor; retained on the struct so the engine is self-describing.
    #[cfg_attr(not(test), allow(dead_code))]
    root: PathBuf,
    git: Vec<ScopedMatcher>,
    marrow: Vec<ScopedMatcher>,
}

impl IgnoreEngine {
    /// Build the engine by discovering every `.gitignore` and `.marrowignore`
    /// under `root`. Matchers are ordered shallow→deep so deeper ones win.
    pub fn new(root: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root = root.as_ref().to_path_buf();
        let mut git = Vec::new();
        let mut marrow = Vec::new();

        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
        {
            let name = entry.file_name().to_string_lossy();
            let kind = if name == GITIGNORE {
                Some(&mut git)
            } else if name == MARROWIGNORE {
                Some(&mut marrow)
            } else {
                None
            };
            let Some(bucket) = kind else { continue };
            // Skip ignore files buried inside a .git directory.
            if entry.path().components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            if let Some(matcher) = build_scoped(&root, entry.path())? {
                bucket.push(matcher);
            }
        }

        // Shallow first so that, when we iterate in reverse, deeper matchers take
        // precedence (Git semantics).
        git.sort_by_key(|a| depth(&a.dir));
        marrow.sort_by_key(|a| depth(&a.dir));

        Ok(Self { root, git, marrow })
    }

    /// Resolve a single path (relative to the root) into an `IgnoreDecision`.
    ///
    /// `size` is the file's byte length, used for the `MAX_FILE_SIZE` rule; pass
    /// `None` for directories (the size rule is skipped).
    pub fn decide(&self, rel_path: &str, is_dir: bool, size: Option<u64>) -> IgnoreDecision {
        let rel = normalize(rel_path);
        let base = basename(&rel);

        // (1) Always-ignored. `.marrowignore` negation may re-include all but `.git`.
        if let Some(seg) = first_always_segment(&rel) {
            let never = NEVER_SYNCED.contains(&seg.as_str());
            if !never {
                if let Some(reason) = self.marrow_negation(&rel, is_dir) {
                    return IgnoreDecision {
                        path: rel,
                        included: true,
                        reason,
                    };
                }
            }
            return IgnoreDecision {
                path: rel,
                included: false,
                reason: IgnoreReason::bare(IgnoreSourceKind::Always),
            };
        }

        // (2) A `.gitkeep` file is always kept (materializes its directory).
        if base == GITKEEP {
            return IgnoreDecision {
                path: rel,
                included: true,
                reason: IgnoreReason::bare(IgnoreSourceKind::Gitkeep),
            };
        }

        // (3) Cascading .gitignore.
        let git_match = self.match_in(&self.git, &rel, is_dir);
        // (4) .marrowignore layered on top.
        let marrow_match = self.match_in(&self.marrow, &rel, is_dir);

        // .marrowignore is authoritative when it speaks (it may widen or narrow).
        if let Some(m) = &marrow_match {
            return IgnoreDecision {
                path: rel,
                included: m.whitelist,
                reason: m.reason(IgnoreSourceKind::Marrowignore),
            };
        }

        // (5) Size cap — only when nothing re-included it via .marrowignore above.
        if let Some(bytes) = size {
            if !is_dir && bytes > MAX_FILE_SIZE {
                return IgnoreDecision {
                    path: rel,
                    included: false,
                    reason: IgnoreReason::bare(IgnoreSourceKind::Size),
                };
            }
        }

        if let Some(m) = &git_match {
            return IgnoreDecision {
                path: rel,
                included: m.whitelist,
                reason: m.reason(IgnoreSourceKind::Gitignore),
            };
        }

        IgnoreDecision {
            path: rel,
            included: true,
            reason: IgnoreReason::bare(IgnoreSourceKind::None),
        }
    }

    /// Convenience: is this path synced?
    pub fn is_included(&self, rel_path: &str, is_dir: bool, size: Option<u64>) -> bool {
        self.decide(rel_path, is_dir, size).included
    }

    /// Find the deepest, last-winning match across a set of scoped matchers.
    fn match_in(&self, matchers: &[ScopedMatcher], rel: &str, is_dir: bool) -> Option<MatchHit> {
        // Iterate deepest-first; the first matcher that has an opinion wins
        // (deeper gitignores take precedence over shallower ones).
        for m in matchers.iter().rev() {
            // Only matchers whose directory is an ancestor of the path apply.
            let Some(sub) = strip_dir(&m.dir, rel) else {
                continue;
            };
            // `matched_path_or_any_parents` walks up the path's ancestors so a
            // directory pattern (e.g. `dist/`) correctly excludes everything under
            // it — plain `matched` only tests the leaf and would miss `dist/x.js`.
            // An empty `sub` means the path *is* the matcher's own directory, which
            // has no patterns to match against itself.
            if sub.is_empty() {
                continue;
            }
            let res = m
                .gitignore
                .matched_path_or_any_parents(Path::new(&sub), is_dir);
            match res {
                Match::Ignore(glob) => {
                    return Some(MatchHit::from_glob(m, glob.original(), false));
                }
                Match::Whitelist(glob) => {
                    return Some(MatchHit::from_glob(m, glob.original(), true));
                }
                Match::None => continue,
            }
        }
        None
    }

    /// If a `.marrowignore` explicitly re-includes (`!`) this path, return the reason.
    fn marrow_negation(&self, rel: &str, is_dir: bool) -> Option<IgnoreReason> {
        match self.match_in(&self.marrow, rel, is_dir) {
            Some(hit) if hit.whitelist => Some(hit.reason(IgnoreSourceKind::Marrowignore)),
            _ => None,
        }
    }

    #[cfg(test)]
    fn root(&self) -> &Path {
        &self.root
    }
}

/// A resolved match: which scoped file/pattern decided it and whether it re-includes.
struct MatchHit {
    file: String,
    pattern: String,
    line: Option<u32>,
    whitelist: bool,
}

impl MatchHit {
    fn from_glob(m: &ScopedMatcher, original: &str, whitelist: bool) -> Self {
        let line = m
            .lines
            .iter()
            .position(|l| l.trim() == original.trim())
            .map(|i| (i + 1) as u32);
        Self {
            file: m.file_rel.clone(),
            pattern: original.to_string(),
            line,
            whitelist,
        }
    }

    fn reason(&self, kind: IgnoreSourceKind) -> IgnoreReason {
        IgnoreReason {
            kind,
            file: Some(self.file.clone()),
            pattern: Some(self.pattern.clone()),
            line: self.line,
        }
    }
}

/// Build a scoped matcher for one ignore file, rooted at its own directory so its
/// patterns match relative to where the file lives (correct nested semantics).
fn build_scoped(root: &Path, file: &Path) -> anyhow::Result<Option<ScopedMatcher>> {
    let contents = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let dir = file.parent().unwrap_or(root);
    let mut builder = GitignoreBuilder::new(dir);
    for line in contents.lines() {
        // add_line ignores comments/blanks. Git tolerates/skips unparseable lines
        // rather than aborting, and the engine eagerly compiles EVERY ignore file
        // under the root — so a single malformed pattern anywhere must not break the
        // whole scan. Skip the bad line (keeping the rest) instead of propagating.
        if builder.add_line(Some(file.to_path_buf()), line).is_err() {
            continue;
        }
    }
    let gitignore = builder.build()?;

    let rel_dir = dir
        .strip_prefix(root)
        .unwrap_or(Path::new(""))
        .to_path_buf();
    let file_rel = file
        .strip_prefix(root)
        .map(to_posix)
        .unwrap_or_else(|_| file.to_string_lossy().to_string());

    Ok(Some(ScopedMatcher {
        dir: rel_dir,
        file_rel,
        gitignore,
        lines: contents.lines().map(str::to_string).collect(),
    }))
}

// --- small path helpers (POSIX, root-relative) ---

fn depth(p: &Path) -> usize {
    p.components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count()
}

fn to_posix(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize(rel: &str) -> String {
    // Resolve `.`/`..` segments, clamping `..` at the root so a traversal segment
    // can never escape it. Keeps the Rust core's path handling aligned with the
    // shared `normalizePath` contract and hardens the (TODO) write path against a
    // hostile manifest path like `../../.bashrc` (SPEC §9).
    let mut stack: Vec<String> = Vec::new();
    for seg in rel.replace('\\', "/").split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other.to_string()),
        }
    }
    stack.join("/")
}

fn basename(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// First path segment that equals an always-ignored entry, if any.
fn first_always_segment(rel: &str) -> Option<String> {
    rel.split('/')
        .find(|seg| ALWAYS_IGNORED.contains(seg))
        .map(str::to_string)
}

/// Strip a matcher's directory prefix from a root-relative path, returning the
/// path relative to that directory. `None` if the path is not under the directory.
fn strip_dir(dir: &Path, rel: &str) -> Option<String> {
    let dir_s = to_posix(dir);
    if dir_s.is_empty() {
        return Some(rel.to_string());
    }
    let prefix = format!("{dir_s}/");
    if rel == dir_s {
        Some(String::new())
    } else {
        rel.strip_prefix(&prefix).map(str::to_string)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str, contents: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contents).unwrap();
    }

    fn engine(td: &TempDir) -> IgnoreEngine {
        IgnoreEngine::new(td.path()).unwrap()
    }

    #[test]
    fn plain_file_is_included() {
        let td = TempDir::new().unwrap();
        write(td.path(), "src/main.rs", "fn main() {}");
        let e = engine(&td);
        let d = e.decide("src/main.rs", false, Some(12));
        assert!(d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::None);
    }

    #[test]
    fn normalize_resolves_and_clamps_traversal() {
        assert_eq!(normalize("a/b/../c"), "a/c");
        assert_eq!(normalize("a/./b"), "a/b");
        assert_eq!(normalize("src\\lib\\index.rs"), "src/lib/index.rs");
        // `..` can never escape the root.
        assert_eq!(normalize("../../.bashrc"), ".bashrc");
        assert_eq!(normalize("a/../../b"), "b");
        assert_eq!(normalize(".."), "");
    }

    #[test]
    fn root_gitignore_excludes() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".gitignore", "target/\n*.log\n");
        write(td.path(), "build.log", "x");
        let e = engine(&td);
        let d = e.decide("build.log", false, Some(1));
        assert!(!d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::Gitignore);
        assert_eq!(d.reason.pattern.as_deref(), Some("*.log"));
        assert_eq!(d.reason.file.as_deref(), Some(".gitignore"));
        assert_eq!(d.reason.line, Some(2));
    }

    #[test]
    fn nested_gitignore_takes_precedence_and_reincludes() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".gitignore", "*.tmp\n");
        // Deeper file re-includes a .tmp under src/.
        write(td.path(), "src/.gitignore", "!keep.tmp\n");
        let e = engine(&td);

        let excluded = e.decide("a.tmp", false, Some(1));
        assert!(!excluded.included);

        let reincluded = e.decide("src/keep.tmp", false, Some(1));
        assert!(reincluded.included, "deeper !keep.tmp should re-include");
        assert_eq!(reincluded.reason.kind, IgnoreSourceKind::Gitignore);
        assert_eq!(reincluded.reason.file.as_deref(), Some("src/.gitignore"));
    }

    #[test]
    fn marrowignore_can_widen_over_gitignore() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".gitignore", "dist/\n");
        // Marrow wants dist/ synced even though git ignores it.
        write(td.path(), ".marrowignore", "!dist/\n");
        let e = engine(&td);
        let d = e.decide("dist/bundle.js", false, Some(10));
        assert!(d.included, ".marrowignore !dist/ should re-include");
        assert_eq!(d.reason.kind, IgnoreSourceKind::Marrowignore);
    }

    #[test]
    fn marrowignore_can_narrow() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".marrowignore", "secret/\n");
        let e = engine(&td);
        let d = e.decide("secret/key.txt", false, Some(3));
        assert!(!d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::Marrowignore);
    }

    #[test]
    fn always_ignored_git_never_synced_even_with_negation() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".marrowignore", "!.git/\n");
        let e = engine(&td);
        let d = e.decide(".git/config", false, Some(1));
        assert!(!d.included, ".git is never synced");
        assert_eq!(d.reason.kind, IgnoreSourceKind::Always);
    }

    #[test]
    fn always_ignored_ds_store_blocked_but_reincludable() {
        let td = TempDir::new().unwrap();
        let e = engine(&td);
        let blocked = e.decide(".DS_Store", false, Some(1));
        assert!(!blocked.included);
        assert_eq!(blocked.reason.kind, IgnoreSourceKind::Always);

        // With an explicit marrowignore negation it can be re-included.
        write(td.path(), ".marrowignore", "!.DS_Store\n");
        let e2 = engine(&td);
        let allowed = e2.decide(".DS_Store", false, Some(1));
        assert!(allowed.included);
        assert_eq!(allowed.reason.kind, IgnoreSourceKind::Marrowignore);
    }

    #[test]
    fn gitkeep_always_kept() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".gitignore", "empty/\n");
        let e = engine(&td);
        let d = e.decide("empty/.gitkeep", false, Some(0));
        assert!(d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::Gitkeep);
    }

    #[test]
    fn oversize_file_excluded() {
        let td = TempDir::new().unwrap();
        let e = engine(&td);
        let d = e.decide("huge.bin", false, Some(MAX_FILE_SIZE + 1));
        assert!(!d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::Size);
    }

    #[test]
    fn oversize_file_reincludable_by_marrowignore() {
        let td = TempDir::new().unwrap();
        write(td.path(), ".marrowignore", "!huge.bin\n");
        let e = engine(&td);
        let d = e.decide("huge.bin", false, Some(MAX_FILE_SIZE + 1));
        assert!(d.included);
        assert_eq!(d.reason.kind, IgnoreSourceKind::Marrowignore);
    }

    #[test]
    fn malformed_pattern_is_skipped_not_fatal() {
        let td = TempDir::new().unwrap();
        // `[` opens a character class that is never closed — an invalid glob. Git
        // skips such lines; the engine must too, and still honor the valid lines.
        write(td.path(), ".gitignore", "*.log\n[unterminated\nbuild/\n");
        write(td.path(), "app.log", "x");
        // Build must succeed despite the bad line.
        let e = IgnoreEngine::new(td.path()).expect("malformed line should not abort build");

        let logged = e.decide("app.log", false, Some(1));
        assert!(!logged.included, "valid *.log rule still applies");
        assert_eq!(logged.reason.pattern.as_deref(), Some("*.log"));

        let built = e.decide("build/out", false, Some(1));
        assert!(
            !built.included,
            "valid build/ rule after the bad line applies"
        );
    }

    #[test]
    fn engine_exposes_root() {
        let td = TempDir::new().unwrap();
        let e = engine(&td);
        assert_eq!(e.root(), td.path());
    }
}
