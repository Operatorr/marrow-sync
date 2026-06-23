// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Presigned R2 (S3-compatible) URL generation (SPEC §6/§9).
 *
 * The Worker NEVER proxies chunk bytes. It mints short-lived presigned URLs with
 * `aws4fetch` and the client transfers directly to/from R2:
 *   - `presignPut`  → upload a missing chunk (POST /chunks/check).
 *   - `presignGet`  → download a needed chunk (POST /chunks/download).
 *
 * The R2 object key is the chunk hash, prefixed by `userId/` so a hash cannot
 * leak existence across users (per-user dedup scope, SPEC §6).
 */

import { AwsClient } from "aws4fetch";

import { type Env } from "../env";

/**
 * Default presigned-URL lifetime, in seconds. Kept short: a presigned URL is a
 * bearer credential for one object in the user's namespace, and a direct R2
 * transfer needs only a brief window. Callers may pass less; never more than
 * {@link MAX_EXPIRES_SECONDS} (clamped in {@link presign}).
 */
export const DEFAULT_EXPIRES_SECONDS = 900;

/** Hard ceiling on presigned-URL lifetime, regardless of the requested value. */
export const MAX_EXPIRES_SECONDS = 3600;

/** R2 requires the literal region `auto` in the SigV4 credential scope. */
const R2_REGION = "auto";

/** Build the per-user R2 object key for a chunk hash (SPEC §6). */
export function chunkKey(userId: string, hash: string): string {
  return `${userId}/${hash}`;
}

/**
 * Construct the S3-style endpoint URL for an object in the chunks bucket. Each
 * path segment is URL-encoded so a key never alters the URL structure; combined
 * with hex-validated hashes at the route boundary, the signed canonical path
 * always matches what R2 resolves.
 */
export function objectUrl(env: Env, key: string): string {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${host}/${env.R2_BUCKET}/${path}`;
}

/** A configured aws4fetch client for signing R2 requests. */
export function r2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: R2_REGION,
  });
}

async function presign(
  env: Env,
  method: "PUT" | "GET",
  key: string,
  expiresSeconds: number,
): Promise<string> {
  const url = new URL(objectUrl(env, key));
  // X-Amz-Expires is part of the signed query for presigned URLs. Clamp to the
  // ceiling so a caller can never mint a long-lived URL.
  const expires = Math.min(Math.max(1, Math.floor(expiresSeconds)), MAX_EXPIRES_SECONDS);
  url.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await r2Client(env).sign(url.toString(), {
    method,
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Presigned PUT URL to upload the chunk at `hash` for `userId`. */
export function presignPut(
  env: Env,
  userId: string,
  hash: string,
  expiresSeconds: number = DEFAULT_EXPIRES_SECONDS,
): Promise<string> {
  return presign(env, "PUT", chunkKey(userId, hash), expiresSeconds);
}

/** Presigned GET URL to download the chunk at `hash` for `userId`. */
export function presignGet(
  env: Env,
  userId: string,
  hash: string,
  expiresSeconds: number = DEFAULT_EXPIRES_SECONDS,
): Promise<string> {
  return presign(env, "GET", chunkKey(userId, hash), expiresSeconds);
}
