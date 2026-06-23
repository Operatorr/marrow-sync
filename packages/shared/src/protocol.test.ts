// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { conflictCopyName, hasTraversal, normalizePath } from "./protocol";
import { CHUNK_SIZE, MAX_FILE_SIZE, PROTOCOL_VERSION } from "./constants";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\lib\\index.ts")).toBe("src/lib/index.ts");
  });

  it("collapses duplicate slashes and strips leading ./ and /", () => {
    expect(normalizePath("./src//lib///a.ts")).toBe("src/lib/a.ts");
    expect(normalizePath("/abs/path/")).toBe("abs/path");
  });

  it("resolves interior . and .. segments", () => {
    expect(normalizePath("a/b/../c")).toBe("a/c");
    expect(normalizePath("a/./b")).toBe("a/b");
  });

  it("clamps .. so it can never escape the root", () => {
    expect(normalizePath("../../.bashrc")).toBe(".bashrc");
    expect(normalizePath("a/../../b")).toBe("b");
    expect(normalizePath("..")).toBe("");
  });

  it("maps all degenerate root-ish inputs to the empty string", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath(".")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("///")).toBe("");
    expect(normalizePath("a/..")).toBe("");
  });

  it("is idempotent and never re-introduces traversal", () => {
    for (const p of ["../../x", "a/../../b", "./a//b/../c", "\\a\\..\\b"]) {
      const once = normalizePath(p);
      expect(normalizePath(once)).toBe(once);
      expect(hasTraversal(once)).toBe(false);
    }
  });

  it("treats a Windows drive letter as an ordinary segment (input must be root-relative)", () => {
    // Documented behavior: drive letters are NOT stripped; the Rust normalize() agrees.
    expect(normalizePath("C:\\foo")).toBe("C:/foo");
  });

  it("preserves unicode segments unchanged", () => {
    expect(normalizePath("src/café/файл.ts")).toBe("src/café/файл.ts");
  });
});

describe("hasTraversal", () => {
  it("flags any .. segment", () => {
    expect(hasTraversal("../x")).toBe(true);
    expect(hasTraversal("a/../b")).toBe(true);
    expect(hasTraversal("a\\..\\b")).toBe(true);
    expect(hasTraversal("..")).toBe(true);
    expect(hasTraversal("a/..")).toBe(true);
    expect(hasTraversal("..\\secret")).toBe(true);
  });

  it("does not flag normal paths or .. inside a filename", () => {
    expect(hasTraversal("src/lib/a.ts")).toBe(false);
    expect(hasTraversal("weird..name.ts")).toBe(false);
  });
});

describe("conflictCopyName", () => {
  it("inserts the marker before the extension with a UTC second-granularity stamp", () => {
    const out = conflictCopyName("notes.md", "Alex's MacBook", new Date("2026-06-22T10:00:05Z"));
    expect(out).toBe("notes (conflicted copy from Alex's MacBook, 2026-06-22 10-00-05).md");
  });

  it("does not collide for two conflicts seconds apart", () => {
    const a = conflictCopyName("a.ts", "PC", new Date("2026-06-22T10:00:00Z"));
    const b = conflictCopyName("a.ts", "PC", new Date("2026-06-22T10:00:01Z"));
    expect(a).not.toBe(b);
  });

  it("handles dotfiles, extensionless, and multi-dot names", () => {
    expect(conflictCopyName("Makefile", "PC", new Date("2026-01-02T00:00:00Z"))).toBe(
      "Makefile (conflicted copy from PC, 2026-01-02 00-00-00)",
    );
    // Leading-dot file: the dot at index 0 is not treated as an extension separator.
    expect(conflictCopyName(".gitignore", "PC", new Date("2026-01-02T00:00:00Z"))).toBe(
      ".gitignore (conflicted copy from PC, 2026-01-02 00-00-00)",
    );
    // Multi-dot: split on the LAST dot only.
    expect(conflictCopyName("a.tar.gz", "PC", new Date("2026-01-02T00:00:00Z"))).toBe(
      "a.tar (conflicted copy from PC, 2026-01-02 00-00-00).gz",
    );
  });
});

describe("constants", () => {
  it("keeps chunk sizing ordered min < avg < max", () => {
    expect(CHUNK_SIZE.min).toBeLessThan(CHUNK_SIZE.avg);
    expect(CHUNK_SIZE.avg).toBeLessThan(CHUNK_SIZE.max);
  });

  it("pins the spec'd values (SPEC §9) so the Rust mirror can't drift unnoticed", () => {
    expect(CHUNK_SIZE.min).toBe(16 * 1024);
    expect(CHUNK_SIZE.avg).toBe(64 * 1024);
    expect(CHUNK_SIZE.max).toBe(256 * 1024);
    expect(MAX_FILE_SIZE).toBe(512 * 1024 * 1024);
  });

  it("exposes a numeric protocol version", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });
});
