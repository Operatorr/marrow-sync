// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { collectChunkHashes, groupChunks, toManifest } from "./manifest";

describe("toManifest", () => {
  it("renders an active file with mode", () => {
    expect(
      toManifest({
        path: "src/a.ts",
        deleted: 0,
        size: 12,
        mtime: 100,
        mode: 0o644,
        chunks: ["h1", "h2"],
      }),
    ).toEqual({ path: "src/a.ts", size: 12, mtime: 100, mode: 0o644, chunks: ["h1", "h2"] });
  });

  it("omits mode when null", () => {
    const m = toManifest({ path: "a", deleted: 0, size: 1, mtime: 2, mode: null, chunks: [] });
    expect("mode" in m).toBe(false);
  });

  it("renders a tombstone for a deleted file", () => {
    expect(
      toManifest({ path: "gone.txt", deleted: 1, size: 9, mtime: 50, mode: 0o644, chunks: ["x"] }),
    ).toEqual({ path: "gone.txt", size: 0, mtime: 50, chunks: [], deleted: true });
  });
});

describe("groupChunks", () => {
  it("orders chunk hashes by idx within each version", () => {
    const grouped = groupChunks([
      { versionId: "v1", idx: 2, chunkHash: "c" },
      { versionId: "v1", idx: 0, chunkHash: "a" },
      { versionId: "v1", idx: 1, chunkHash: "b" },
      { versionId: "v2", idx: 0, chunkHash: "z" },
    ]);
    expect(grouped.get("v1")).toEqual(["a", "b", "c"]);
    expect(grouped.get("v2")).toEqual(["z"]);
  });
});

describe("collectChunkHashes", () => {
  it("dedups across versions", () => {
    const out = collectChunkHashes([
      { path: "a", size: 1, mtime: 1, chunks: ["h1", "h2"] },
      { path: "b", size: 1, mtime: 1, chunks: ["h2", "h3"] },
    ]);
    expect([...out].sort()).toEqual(["h1", "h2", "h3"]);
  });
});
