// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Best-effort detection of the host platform from the browser environment, used
 * to pre-fill device registration. The Rust side is authoritative; this is only a
 * sensible default for the onboarding form.
 */

import type { Platform } from "@marrow/shared";

/** Guess the {@link Platform} from `navigator`, defaulting to `"linux"`. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const haystack = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
  if (haystack.includes("mac")) return "macos";
  if (haystack.includes("win")) return "windows";
  return "linux";
}

/** A friendly default device name, e.g. `"Marrow on macOS"`. */
export function defaultDeviceName(platform: Platform): string {
  const label = platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux";
  return `Marrow on ${label}`;
}
