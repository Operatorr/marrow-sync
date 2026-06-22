// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sync-root routes (SPEC §7):
 *   GET  /roots   → { roots: SyncRootSummary[] }
 *   POST /roots   create a root → SyncRootSummary
 *
 * Mounted under `/api`. A root carries the per-root logical clock (`seq`).
 */

import { type RootListResponse, type SyncRootSummary } from "@marrow/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDb } from "../db/client";
import { syncRoot } from "../db/schema";
import { type AppBindings } from "../env";

const createRootSchema = z.object({
  name: z.string().min(1).max(200),
});

export const roots = new Hono<AppBindings>()
  .get("/", async (c) => {
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: syncRoot.id,
        name: syncRoot.name,
        seq: syncRoot.seq,
        createdAt: syncRoot.createdAt,
      })
      .from(syncRoot)
      .where(eq(syncRoot.userId, userId));

    const body: RootListResponse = { roots: rows };
    return c.json(body);
  })
  .post("/", zValidator("json", createRootSchema), async (c) => {
    const { name } = c.req.valid("json");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);

    const root = {
      id: crypto.randomUUID(),
      userId,
      name,
      seq: 0,
      createdAt: Date.now(),
    };
    await db.insert(syncRoot).values(root);

    const body: SyncRootSummary = {
      id: root.id,
      name: root.name,
      seq: root.seq,
      createdAt: root.createdAt,
    };
    return c.json(body, 201);
  });
