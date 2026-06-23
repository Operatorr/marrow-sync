// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { IgnoreDecision } from "@marrow/shared";

import {
  describeIgnore,
  formatBytes,
  formatCount,
  formatRelativeTime,
  platformLabel,
} from "./format";

describe("formatBytes", () => {
  it("renders zero and small values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders a dash for non-finite or negative input (never 'NaN')", () => {
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
  });

  it("scales to KB/MB with one decimal where useful", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });

  it("bumps the unit at the rounding boundary (never '1024 KB')", () => {
    // 1048575 B rounds to 1024 KB at one decimal — must roll over to 1 MB.
    const justUnderMb = 1024 * 1024 - 1;
    expect(formatBytes(justUnderMb)).not.toMatch(/1024/);
    expect(formatBytes(justUnderMb)).toBe("1 MB");
  });
});

describe("formatCount", () => {
  it("formats with thousands separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(1_000_000)).toBe("1,000,000");
  });

  it("clamps negatives to zero and guards NaN", () => {
    expect(formatCount(-7)).toBe("0");
    expect(formatCount(NaN)).toBe("0");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;
  it("handles null and recency tiers", () => {
    expect(formatRelativeTime(null, now)).toBe("never");
    expect(formatRelativeTime(now - 2_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 10_000, now)).toBe("10 s ago");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30 s ago");
    expect(formatRelativeTime(now - 60_000, now)).toBe("1 min ago");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe("1 h ago");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe("1 d ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3 d ago");
  });

  it("adds a weeks tier and an absolute-date fallback beyond a month", () => {
    expect(formatRelativeTime(now - 10 * 86_400_000, now)).toBe("1 wk ago");
    expect(formatRelativeTime(now - 21 * 86_400_000, now)).toBe("3 wk ago");
    // ~3 months out falls back to an absolute date rather than "13 wk ago".
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toMatch(/\d{4}/);
  });

  it("reports a future timestamp explicitly (clock skew)", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("in the future");
  });
});

describe("platformLabel", () => {
  it("maps platform ids to friendly labels", () => {
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
  });
});

describe("describeIgnore", () => {
  it("describes an exclusion with the responsible rule", () => {
    const decision: IgnoreDecision = {
      path: "dist/app.js",
      included: false,
      reason: { kind: "gitignore", file: "src/.gitignore", pattern: "dist/", line: 4 },
    };
    expect(describeIgnore(decision)).toBe(
      "Excluded by .gitignore at src/.gitignore (line 4: dist/)",
    );
  });

  it("describes a clean inclusion and a gitkeep", () => {
    expect(describeIgnore({ path: "a.ts", included: true, reason: { kind: "none" } })).toBe(
      "Included (no rule matched)",
    );
    expect(
      describeIgnore({
        path: "empty/.gitkeep",
        included: true,
        reason: { kind: "gitkeep", file: "empty/.gitkeep" },
      }),
    ).toBe("Kept by .gitkeep at empty/.gitkeep");
  });

  it("describes a .marrowignore exclusion with a pattern but no line", () => {
    expect(
      describeIgnore({
        path: "secrets.env",
        included: false,
        reason: { kind: "marrowignore", file: ".marrowignore", pattern: "*.env" },
      }),
    ).toBe("Excluded by .marrowignore at .marrowignore (*.env)");
  });

  it("describes an always-ignored exclusion (no file/pattern)", () => {
    expect(
      describeIgnore({ path: ".git/config", included: false, reason: { kind: "always" } }),
    ).toBe("Excluded by an always-ignored rule");
  });

  it("describes a size-limit exclusion", () => {
    expect(describeIgnore({ path: "huge.bin", included: false, reason: { kind: "size" } })).toBe(
      "Excluded by the file-size limit",
    );
  });
});
