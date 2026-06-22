// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device-token generation + hashing (SPEC §10).
 *
 * A device token is high-entropy random material shown to the client exactly
 * once and stored only in the OS secure store. The server keeps just the
 * sha-256 hex hash — the raw token is never logged or persisted.
 */

/** Generate a high-entropy, URL-safe device token. */
export function generateDeviceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url without padding — compact and safe in an Authorization header.
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lowercase sha-256 hex of a token, the form stored/compared server-side. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
