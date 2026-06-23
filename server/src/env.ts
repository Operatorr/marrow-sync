// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Worker runtime environment: Cloudflare bindings + secrets (SPEC §13).
 *
 * Bindings (`DB`, `BUCKET`) come from `wrangler.toml`; the rest are vars/secrets
 * supplied via `.dev.vars` locally or `wrangler secret put` in production. Never
 * commit real secret values (SPEC §14).
 */

export interface Env {
  /** Cloudflare D1 database binding (metadata store). */
  DB: D1Database;
  /** Cloudflare R2 bucket binding (content-addressed chunk blobs). */
  BUCKET: R2Bucket;

  // --- better-auth (secrets — never log) ---
  /** HMAC secret used to sign sessions; presence asserted in `createAuth`. */
  BETTER_AUTH_SECRET: string;
  /** Public base URL the Worker is served from (OAuth callbacks). */
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  /** GitHub OAuth app secret — never log. */
  GITHUB_CLIENT_SECRET: string;

  // --- R2 presigning (aws4fetch) — secrets, never log ---
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Bucket name used to build the presigned object URL; must equal wrangler `bucket_name`. */
  R2_BUCKET: string;
}

/**
 * Hono per-request `Variables`, populated by the auth middleware. Every
 * authenticated request resolves to exactly one owning `user_id`; `deviceId` is
 * set only when the caller authenticated with a device token (SPEC §10).
 */
export interface Variables {
  userId: string;
  deviceId: string | null;
}

/** The Hono generics bundle used across the app for typed `c.env` / `c.var`. */
export interface AppBindings {
  Bindings: Env;
  Variables: Variables;
}
