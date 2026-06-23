// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request authentication (SPEC §10). A caller is authenticated by EITHER:
 *   - a Marrow device token in `Authorization: Bearer <token>` (the sync path),
 *     looked up by its sha-256 hash; sets `userId` + `deviceId`, or
 *   - a better-auth session cookie (the web/management path); sets `userId`,
 *     `deviceId = null`.
 *
 * On success it stamps `c.var.userId` / `c.var.deviceId`; otherwise it throws a
 * 401 rendered by the error middleware. The raw token is never logged.
 */

import { eq } from "drizzle-orm";
import { type MiddlewareHandler } from "hono";

import { getAuth } from "../auth";
import { createDb } from "../db/client";
import { device } from "../db/schema";
import { type AppBindings } from "../env";
import { hashToken } from "../lib/token";
import { errors } from "./error";

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const header = c.req.header("Authorization");

  // 1. Device token (Bearer) — the primary sync credential. The auth scheme is
  // case-insensitive per RFC 7235, so accept `bearer`/`BEARER` too. All token
  // failures return the SAME generic 401 so the response can't be used to probe
  // which branch was taken (no token-existence enumeration).
  const bearer = header ? /^Bearer[ \t]+(\S.*)$/i.exec(header) : null;
  if (bearer) {
    const token = bearer[1]!.trim();

    const tokenHash = await hashToken(token);
    const db = createDb(c.env.DB);
    // Looked up by sha-256 hash via the UNIQUE index on token_hash. The compared
    // value is a hash of a 256-bit secret, so an indexed equality is the standard
    // mitigation — do NOT refactor to fetch-then-compare without a constant-time
    // comparison, which would introduce a timing oracle.
    const [row] = await db
      .select({ id: device.id, userId: device.userId })
      .from(device)
      .where(eq(device.tokenHash, tokenHash))
      .limit(1);

    if (!row) throw errors.unauthorized();

    c.set("userId", row.userId);
    c.set("deviceId", row.id);
    return next();
  }

  // 2. better-auth session (cookie) — the web/management credential.
  const session = await getAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (session?.user?.id) {
    c.set("userId", session.user.id);
    c.set("deviceId", null);
    return next();
  }

  throw errors.unauthorized();
};
