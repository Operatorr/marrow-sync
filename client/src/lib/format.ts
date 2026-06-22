// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Small, pure UI formatting helpers. Kept dependency-free and unit-tested so the
 * views can stay declarative.
 */

import type { IgnoreDecision, IgnoreSourceKind, Platform } from "@marrow/shared";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable byte count, e.g. `1536` → `"1.5 KB"`. Base-1024. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  // Whole numbers stay integers; otherwise one decimal place.
  const rounded =
    value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[exponent]}`;
}

/** A short integer count with thousands separators, e.g. `12345` → `"12,345"`. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.trunc(n)));
}

/**
 * Relative "time ago" for a sync timestamp (epoch ms), e.g. `"just now"`,
 * `"3 min ago"`, `"2 h ago"`. `null` renders as `"never"`. Anchored against
 * `now` (injectable for deterministic tests).
 */
export function formatRelativeTime(epochMs: number | null, now: number = Date.now()): string {
  if (epochMs === null) return "never";
  const deltaSec = Math.max(0, Math.round((now - epochMs) / 1000));
  if (deltaSec < 10) return "just now";
  if (deltaSec < 60) return `${deltaSec} s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** Human label for a device platform. */
export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "linux":
      return "Linux";
  }
}

/**
 * One-line, human explanation of an ignore decision (SPEC §8), e.g.
 * `"Excluded by .gitignore at src/.gitignore (line 4: node_modules/)"`.
 */
export function describeIgnore(decision: IgnoreDecision): string {
  const { included, reason } = decision;
  if (included && reason.kind === "none") return "Included (no rule matched)";
  if (included && reason.kind === "gitkeep") {
    return `Kept by .gitkeep${reason.file ? ` at ${reason.file}` : ""}`;
  }
  if (included) {
    return `Re-included by ${sourceLabel(reason.kind)}${formatRule(decision)}`;
  }

  const verb = `Excluded by ${sourceLabel(reason.kind)}`;
  return `${verb}${reason.file ? ` at ${reason.file}` : ""}${formatRule(decision)}`;
}

function formatRule(decision: IgnoreDecision): string {
  const { pattern, line } = decision.reason;
  if (!pattern) return "";
  return ` (${line ? `line ${line}: ` : ""}${pattern})`;
}

function sourceLabel(kind: IgnoreSourceKind): string {
  switch (kind) {
    case "gitignore":
      return ".gitignore";
    case "marrowignore":
      return ".marrowignore";
    case "gitkeep":
      return ".gitkeep";
    case "always":
      return "an always-ignored rule";
    case "size":
      return "the file-size limit";
    case "none":
      return "no rule";
  }
}
