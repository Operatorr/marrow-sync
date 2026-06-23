// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { commitSchema, versionManifestSchema } from "./changes";

const HASH = "a".repeat(64);

/** A minimal valid live manifest for one path. */
function liveManifest(path: string, chunks: string[] = [HASH]) {
  return { path, size: 1, mtime: 1, chunks };
}

describe("versionManifestSchema", () => {
  it("accepts a live file with ≥1 hex chunk", () => {
    expect(versionManifestSchema.safeParse(liveManifest("a.ts")).success).toBe(true);
  });

  it("rejects a live file with no chunks", () => {
    expect(versionManifestSchema.safeParse(liveManifest("a.ts", [])).success).toBe(false);
  });

  it("rejects a deleted file that carries chunks", () => {
    const m = { path: "a.ts", size: 0, mtime: 1, chunks: [HASH], deleted: true };
    expect(versionManifestSchema.safeParse(m).success).toBe(false);
  });

  it("accepts a tombstone with no chunks", () => {
    const m = { path: "a.ts", size: 0, mtime: 1, chunks: [], deleted: true };
    expect(versionManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects a non-hex / wrong-length chunk hash", () => {
    expect(versionManifestSchema.safeParse(liveManifest("a.ts", ["nothex"])).success).toBe(false);
    expect(versionManifestSchema.safeParse(liveManifest("a.ts", ["A".repeat(64)])).success).toBe(
      false,
    );
    expect(versionManifestSchema.safeParse(liveManifest("a.ts", ["a".repeat(63)])).success).toBe(
      false,
    );
  });

  it("rejects negative size/mtime", () => {
    expect(versionManifestSchema.safeParse({ ...liveManifest("a.ts"), size: -1 }).success).toBe(
      false,
    );
  });
});

describe("commitSchema", () => {
  it("accepts a clean single-version commit", () => {
    const r = commitSchema.safeParse({ baseSeq: 0, versions: [liveManifest("a.ts")] });
    expect(r.success).toBe(true);
  });

  it("rejects an empty versions array", () => {
    expect(commitSchema.safeParse({ baseSeq: 0, versions: [] }).success).toBe(false);
  });

  it("rejects a path that escapes the root via ..", () => {
    const r = commitSchema.safeParse({ baseSeq: 0, versions: [liveManifest("../../etc/passwd")] });
    expect(r.success).toBe(false);
  });

  it("rejects two manifests whose paths normalize to the same value", () => {
    const r = commitSchema.safeParse({
      baseSeq: 0,
      versions: [liveManifest("a/b.ts"), liveManifest("a/./b.ts")],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a negative baseSeq", () => {
    expect(commitSchema.safeParse({ baseSeq: -1, versions: [liveManifest("a.ts")] }).success).toBe(
      false,
    );
  });
});
