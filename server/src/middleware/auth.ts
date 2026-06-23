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

  // 1. Device token (Bearer) — the primary sync credential.
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) throw errors.unauthorized("Empty bearer token");

    const tokenHash = await hashToken(token);
    const db = createDb(c.env.DB);
    const [row] = await db
      .select({ id: device.id, userId: device.userId })
      .from(device)
      .where(eq(device.tokenHash, tokenHash))
      .limit(1);

    if (!row) throw errors.unauthorized("Invalid device token");

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
