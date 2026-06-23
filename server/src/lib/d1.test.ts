// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { chunkArray, IN_ARRAY_CHUNK, selectInChunks } from "./d1";

describe("chunkArray", () => {
  it("splits into consecutive slices of at most `size`", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns [] for empty input and a single slice when it fits", () => {
    expect(chunkArray([], 3)).toEqual([]);
    expect(chunkArray([1, 2], 3)).toEqual([[1, 2]]);
  });

  it("defaults to the D1-safe chunk size", () => {
    const items = Array.from({ length: IN_ARRAY_CHUNK + 1 }, (_, i) => i);
    const slices = chunkArray(items);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toHaveLength(IN_ARRAY_CHUNK);
    expect(slices[1]).toHaveLength(1);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunkArray([1], 0)).toThrow();
  });
});

describe("selectInChunks", () => {
  it("issues no query and returns [] for empty input", async () => {
    let calls = 0;
    const out = await selectInChunks(
      [],
      async (slice) => {
        calls++;
        return slice;
      },
      2,
    );
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("runs each slice and concatenates the rows", async () => {
    const seen: number[][] = [];
    const out = await selectInChunks(
      [1, 2, 3, 4, 5],
      async (slice) => {
        seen.push(slice);
        return slice.map((n) => n * 10);
      },
      2,
    );
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
    expect(out.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it("runs a single slice when input fits the default size", async () => {
    let calls = 0;
    const out = await selectInChunks([1, 2, 3], async (slice) => {
      calls++;
      return slice;
    });
    expect(calls).toBe(1);
    expect(out).toEqual([1, 2, 3]);
  });

  it("validates the chunk size before short-circuiting on empty input", async () => {
    await expect(selectInChunks([], async (s) => s, 0)).rejects.toThrow();
  });

  it("does not de-duplicate input values (caller's responsibility)", async () => {
    const out = await selectInChunks([1, 1, 2], async (slice) => slice, 5);
    expect(out).toEqual([1, 1, 2]);
  });
});
