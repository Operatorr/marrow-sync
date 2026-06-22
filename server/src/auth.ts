// SPDX-License-Identifier: AGPL-3.0-only

/**
 * better-auth instance (SPEC §10). GitHub OAuth is the primary human-identity
 * provider; device tokens (see `middleware/auth.ts`) authenticate sync calls.
 *
 * Dual-mode factory:
 *   - `createAuth(env)` is called at runtime with the Worker `Env`, binding a
 *     real Drizzle/D1 database and the per-deployment secrets.
 *   - `auth` (no env) is the static instance the `@better-auth/cli` introspects
 *     to generate/verify the auth schema. It must construct without bindings, so
 *     the database is a harmless placeholder there.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

import { schema } from "./db/schema";
import { type Env } from "./env";

export function createAuth(env?: Env) {
  // At runtime `env.DB` is a real D1 binding; for the CLI we pass an empty object
  // — the adapter only needs the schema to introspect table shapes.
  const db = env ? drizzle(env.DB, { schema }) : ({} as ReturnType<typeof drizzle>);

  return betterAuth({
    baseURL: env?.BETTER_AUTH_URL,
    secret: env?.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    // Avoid CPU-heavy password hashing on the Workers free tier (SPEC §10).
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: env?.GITHUB_CLIENT_ID ?? "",
        clientSecret: env?.GITHUB_CLIENT_SECRET ?? "",
      },
    },
  });
}

/** Static instance for the better-auth CLI (schema generation). */
export const auth = createAuth();

export type Auth = ReturnType<typeof createAuth>;
