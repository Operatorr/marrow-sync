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

/** Default presigned-URL lifetime, in seconds. */
export const DEFAULT_EXPIRES_SECONDS = 3600;

/** R2's S3 region label. */
const R2_REGION = "auto";

/** Build the per-user R2 object key for a chunk hash (SPEC §6). */
export function chunkKey(userId: string, hash: string): string {
  return `${userId}/${hash}`;
}

/** Construct the S3-style endpoint URL for an object in the chunks bucket. */
export function objectUrl(env: Env, key: string): string {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return `https://${host}/${env.R2_BUCKET}/${key}`;
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
  // X-Amz-Expires is part of the signed query for presigned URLs.
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
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
