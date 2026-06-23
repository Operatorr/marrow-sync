// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validation for the user-supplied Marrow server URL. The device bearer token is
 * attached to every RPC call (SPEC §5/§10), so we must never let it leave for an
 * arbitrary or cleartext origin: we require `https:` (allowing `http:` only for
 * loopback dev), reject query strings and fragments, and normalize to a clean
 * `origin + path` with no trailing slash. Both the RPC client (`api/client.ts`)
 * and the Settings form validate with this single helper so they can never
 * disagree about what a "valid server URL" is.
 */

/** Loopback hosts where cleartext `http:` is acceptable for local development. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate and normalize a server URL. Returns the cleaned `origin + path` (no
 * trailing slash, no query/fragment) on success, or throws an {@link Error} with
 * a human-readable reason on invalid input.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("Server URL is required.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid URL, e.g. https://api.marrow.dev");
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol === "http:") {
    if (!isLoopback) {
      throw new Error("Use https:// — http:// is only allowed for localhost.");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Server URL must use https:// (or http:// for localhost).");
  }

  if (url.search) throw new Error("Server URL must not contain a query string.");
  if (url.hash) throw new Error("Server URL must not contain a fragment.");

  // Drop a trailing slash from the path so route concatenation stays clean,
  // but keep a bare-origin path empty (origin already has no trailing slash).
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}
