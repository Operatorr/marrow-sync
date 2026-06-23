// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Best-effort detection of the host platform from the browser environment, used
 * to pre-fill device registration. The Rust side is authoritative; this is only a
 * sensible default for the onboarding form.
 */

import type { Platform } from "@marrow/shared";

/**
 * Guess the {@link Platform} from `navigator`, defaulting to `"linux"`.
 *
 * Matches specific tokens rather than loose substrings: `"win"` is a substring of
 * `"Darwin"` (the kernel name macOS reports in some UAs), so a naive
 * `includes("win")` would misclassify macOS as Windows. macOS is checked first
 * for the same reason.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const haystack = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (haystack.includes("mac") || haystack.includes("macintosh")) return "macos";
  if (haystack.includes("windows") || haystack.includes("win32")) return "windows";
  if (haystack.includes("linux")) return "linux";
  return "linux";
}

/** Human label for a device platform, e.g. `"macos"` → `"macOS"`. */
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

/** A friendly default device name, e.g. `"Marrow on macOS"`. */
export function defaultDeviceName(platform: Platform): string {
  return `Marrow on ${platformLabel(platform)}`;
}
