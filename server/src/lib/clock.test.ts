// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { bump, isConflict, parseSince } from "./clock";

describe("bump", () => {
  it("produces a strictly increasing sequence starting at 1", () => {
    expect(bump(0)).toBe(1);
    expect(bump(41)).toBe(42);
  });
});

describe("isConflict", () => {
  it("flags a file changed after the committer's base", () => {
    expect(isConflict(5, 3)).toBe(true);
  });

  it("does not flag a file at or below the base", () => {
    expect(isConflict(3, 3)).toBe(false);
    expect(isConflict(2, 3)).toBe(false);
  });
});

describe("parseSince", () => {
  it("defaults to 0 for missing or invalid input", () => {
    expect(parseSince(undefined)).toBe(0);
    expect(parseSince("not-a-number")).toBe(0);
    expect(parseSince("-4")).toBe(0);
    expect(parseSince("1.5")).toBe(0);
    expect(parseSince("")).toBe(0);
  });

  it("rejects Number() quirks that would silently shift the cursor", () => {
    expect(parseSince("1e3")).toBe(0);
    expect(parseSince("0x10")).toBe(0);
    expect(parseSince(" 7")).toBe(0);
    expect(parseSince("Infinity")).toBe(0);
    expect(parseSince("+7")).toBe(0);
  });

  it("rejects magnitudes beyond MAX_SAFE_INTEGER rather than returning an imprecise cursor", () => {
    expect(parseSince("9".repeat(30))).toBe(0);
    expect(parseSince(String(Number.MAX_SAFE_INTEGER) + "0")).toBe(0);
    expect(parseSince(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("parses a non-negative integer cursor (incl. leading zeros)", () => {
    expect(parseSince("0")).toBe(0);
    expect(parseSince("17")).toBe(17);
    expect(parseSince("007")).toBe(7);
  });
});
