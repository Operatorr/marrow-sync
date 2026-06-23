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

  // Fail fast at the runtime path if a required secret is missing, rather than
  // silently constructing a weakly-configured instance whose failure surfaces
  // deep inside a request (a misconfigured deploy should not boot). The CLI path
  // (no `env`) tolerates absent bindings — it only introspects table shapes.
  if (env) {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ] as const) {
      if (!env[key]) throw new Error(`Missing required auth env: ${key}`);
    }
  }

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

/**
 * Static instance for the better-auth CLI (schema generation) ONLY. Its database
 * is an empty placeholder, so it must never be used in a request handler — use
 * {@link getAuth} with the request `env` there.
 */
export const auth = createAuth();

export type Auth = ReturnType<typeof createAuth>;

// Within a Worker isolate the `env` binding object is stable across requests, so
// keyed by it a WeakMap caches the better-auth instance (and its Drizzle adapter)
// instead of rebuilding it on every authenticated request / `/auth/*` hit. If a
// runtime ever hands a fresh `env` per request the map simply misses — no leak.
const authCache = new WeakMap<Env, Auth>();

/** Memoized runtime accessor for the per-env better-auth instance. */
export function getAuth(env: Env): Auth {
  let instance = authCache.get(env);
  if (!instance) {
    instance = createAuth(env);
    authCache.set(env, instance);
  }
  return instance;
}
