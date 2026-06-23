// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { type Env } from "../env";
import {
  chunkKey,
  DEFAULT_EXPIRES_SECONDS,
  MAX_EXPIRES_SECONDS,
  objectUrl,
  presignGet,
  presignPut,
} from "./r2";

const env = {
  R2_ACCOUNT_ID: "acct123",
  R2_BUCKET: "marrow-chunks",
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexample",
} as unknown as Env;

const HASH = "a".repeat(64);

describe("chunkKey", () => {
  it("prefixes the hash with the user id for per-user isolation", () => {
    expect(chunkKey("user-1", HASH)).toBe(`user-1/${HASH}`);
  });
});

describe("objectUrl", () => {
  it("builds the S3-style R2 endpoint for a key", () => {
    expect(objectUrl(env, `user-1/${HASH}`)).toBe(
      `https://acct123.r2.cloudflarestorage.com/marrow-chunks/user-1/${HASH}`,
    );
  });
});

describe("presignPut / presignGet", () => {
  it("returns a signed PUT URL with a non-empty signature and the keyed path", async () => {
    const url = new URL(await presignPut(env, "user-1", HASH, 600));
    expect(url.pathname).toBe(`/marrow-chunks/user-1/${HASH}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Credential")).toBeTruthy();
  });

  it("uses the default expiry when none is given", async () => {
    const put = new URL(await presignPut(env, "user-1", HASH));
    const get = new URL(await presignGet(env, "user-1", HASH));
    expect(put.searchParams.get("X-Amz-Expires")).toBe(String(DEFAULT_EXPIRES_SECONDS));
    expect(get.searchParams.get("X-Amz-Expires")).toBe(String(DEFAULT_EXPIRES_SECONDS));
  });

  it("clamps an over-long requested expiry to the ceiling", async () => {
    const url = new URL(await presignPut(env, "user-1", HASH, 999_999));
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(MAX_EXPIRES_SECONDS));
  });

  it("mints distinct keyed paths per user (cross-user isolation)", async () => {
    const a = new URL(await presignGet(env, "user-A", HASH));
    const b = new URL(await presignGet(env, "user-B", HASH));
    expect(a.pathname).toBe(`/marrow-chunks/user-A/${HASH}`);
    expect(b.pathname).toBe(`/marrow-chunks/user-B/${HASH}`);
    expect(a.pathname).not.toBe(b.pathname);
  });
});
