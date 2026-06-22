// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { IgnoreDecision } from "@marrow/shared";

import { describeIgnore, formatBytes, formatRelativeTime, platformLabel } from "./format";

describe("formatBytes", () => {
  it("renders zero and small values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales to KB/MB with one decimal where useful", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;
  it("handles null and recency", () => {
    expect(formatRelativeTime(null, now)).toBe("never");
    expect(formatRelativeTime(now - 2_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30 s ago");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3 d ago");
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
});
