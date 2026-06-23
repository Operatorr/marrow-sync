// SPDX-License-Identifier: AGPL-3.0-only

/**
 * drizzle-kit configuration (SPEC §6). Generates the D1 (SQLite) migrations from
 * {@link "./src/db/schema"} into `./migrations`, which are committed and applied
 * with `wrangler d1 migrations apply`.
 *
 * The `d1-http` driver lets `drizzle-kit push`/`studio` talk to D1 directly; it
 * needs Cloudflare credentials supplied via the environment (never committed):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, CLOUDFLARE_D1_TOKEN
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_D1_TOKEN ?? "",
  },
});
