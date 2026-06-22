// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { type Env } from "../env";
import { chunkKey, objectUrl, presignGet, presignPut } from "./r2";

const env = {
  R2_ACCOUNT_ID: "acct123",
  R2_BUCKET: "marrow-chunks",
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexample",
} as unknown as Env;

describe("chunkKey", () => {
  it("prefixes the hash with the user id for per-user isolation", () => {
    expect(chunkKey("user-1", "deadbeef")).toBe("user-1/deadbeef");
  });
});

describe("objectUrl", () => {
  it("builds the S3-style R2 endpoint for a key", () => {
    expect(objectUrl(env, "user-1/deadbeef")).toBe(
      "https://acct123.r2.cloudflarestorage.com/marrow-chunks/user-1/deadbeef",
    );
  });
});

describe("presignPut / presignGet", () => {
  it("returns a signed PUT URL carrying SigV4 query params and the keyed path", async () => {
    const url = await presignPut(env, "user-1", "deadbeef", 600);
    expect(url).toContain("/marrow-chunks/user-1/deadbeef");
    expect(url).toContain("X-Amz-Expires=600");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Credential=");
  });

  it("returns a signed GET URL", async () => {
    const url = await presignGet(env, "user-1", "cafef00d");
    expect(url).toContain("/marrow-chunks/user-1/cafef00d");
    expect(url).toContain("X-Amz-Signature=");
  });
});
