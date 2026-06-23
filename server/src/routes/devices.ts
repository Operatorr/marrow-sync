// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device routes (SPEC §7/§10):
 *   POST   /devices                 register installation → { id, token } (once)
 *   GET    /devices                 → { devices: DeviceSummary[] }
 *   DELETE /devices/:id             revoke a device
 *   POST   /devices/:id/heartbeat   → { lastSeenAt }
 *
 * Mounted under `/api`. The raw token is generated here, returned exactly once,
 * and stored only as its sha-256 hash (SPEC §10).
 */

import {
  type DeviceListResponse,
  type DeviceRegisterResponse,
  type HeartbeatResponse,
  PLATFORMS,
} from "@marrow/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDb } from "../db/client";
import { device } from "../db/schema";
import { type AppBindings } from "../env";
import { errors } from "../middleware/error";
import { generateDeviceToken, hashToken } from "../lib/token";

const registerSchema = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(PLATFORMS),
});

const idParamSchema = z.object({ id: z.string().min(1) });

export const devices = new Hono<AppBindings>()
  .post("/", zValidator("json", registerSchema), async (c) => {
    const { name, platform } = c.req.valid("json");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    // TODO(marrow): no per-user device cap yet — a user can register unbounded
    // devices (resource exhaustion). Acceptable for MVP; add a quota before public
    // sign-ups (SPEC §10/§11).
    const id = crypto.randomUUID();
    const token = generateDeviceToken();
    const tokenHash = await hashToken(token);

    await db.insert(device).values({
      id,
      userId,
      name,
      platform,
      tokenHash,
      createdAt: Date.now(),
      lastSeenAt: null,
    });

    // The raw token is surfaced exactly once; only its hash is persisted.
    const body: DeviceRegisterResponse = { id, token };
    return c.json(body, 201);
  })
  .get("/", async (c) => {
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: device.id,
        name: device.name,
        platform: device.platform,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
      })
      .from(device)
      .where(eq(device.userId, userId));

    const body: DeviceListResponse = {
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform as DeviceListResponse["devices"][number]["platform"],
        createdAt: r.createdAt,
        // `lastSeenAt` is already `number | null` from the select — no coalesce needed.
        lastSeenAt: r.lastSeenAt,
      })),
    };
    return c.json(body);
  })
  .delete("/:id", zValidator("param", idParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const deleted = await db
      .delete(device)
      .where(and(eq(device.id, id), eq(device.userId, userId)))
      .returning({ id: device.id });

    if (deleted.length === 0) throw errors.notFound("Device not found");
    return c.body(null, 204);
  })
  .post("/:id/heartbeat", zValidator("param", idParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const now = Date.now();
    const updated = await db
      .update(device)
      .set({ lastSeenAt: now })
      .where(and(eq(device.id, id), eq(device.userId, userId)))
      .returning({ id: device.id });

    if (updated.length === 0) throw errors.notFound("Device not found");

    const body: HeartbeatResponse = { lastSeenAt: now };
    return c.json(body);
  });
