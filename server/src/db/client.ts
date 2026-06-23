// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drizzle client factory for Cloudflare D1. One instance is created per request
 * from the `DB` binding (Workers have no long-lived process state).
 */

import { drizzle } from "drizzle-orm/d1";

import { schema } from "./schema";

/** Build a schema-aware Drizzle client over the request's D1 binding. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

/** The concrete Drizzle database type, for typing helpers that take a `db`. */
export type Db = ReturnType<typeof createDb>;
