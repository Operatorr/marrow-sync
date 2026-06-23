// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { conflictCopyName, hasTraversal, normalizePath } from "./protocol";
import { CHUNK_SIZE, PROTOCOL_VERSION } from "./constants";

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
});

describe("hasTraversal", () => {
  it("flags any .. segment", () => {
    expect(hasTraversal("../x")).toBe(true);
    expect(hasTraversal("a/../b")).toBe(true);
    expect(hasTraversal("a\\..\\b")).toBe(true);
  });

  it("does not flag normal paths or .. inside a filename", () => {
    expect(hasTraversal("src/lib/a.ts")).toBe(false);
    expect(hasTraversal("weird..name.ts")).toBe(false);
  });
});

describe("conflictCopyName", () => {
  it("inserts the marker before the extension", () => {
    const out = conflictCopyName("notes.md", "Alex's MacBook", new Date("2026-06-22T10:00:00Z"));
    expect(out).toBe("notes (conflicted copy from Alex's MacBook, 2026-06-22).md");
  });

  it("handles dotfiles and extensionless names", () => {
    expect(conflictCopyName("Makefile", "PC", new Date("2026-01-02T00:00:00Z"))).toBe(
      "Makefile (conflicted copy from PC, 2026-01-02)",
    );
    expect(conflictCopyName(".gitignore", "PC", new Date("2026-01-02T00:00:00Z"))).toBe(
      ".gitignore (conflicted copy from PC, 2026-01-02)",
    );
  });
});

describe("constants", () => {
  it("keeps chunk sizing ordered min < avg < max", () => {
    expect(CHUNK_SIZE.min).toBeLessThan(CHUNK_SIZE.avg);
    expect(CHUNK_SIZE.avg).toBeLessThan(CHUNK_SIZE.max);
  });

  it("exposes a numeric protocol version", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });
});
