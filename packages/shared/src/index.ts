// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `@marrow/shared` — the single source of truth both the client and server agree
 * on. Pure types and small pure helpers, with no Node or browser runtime
 * dependencies, so it imports cleanly into the Cloudflare Worker and the
 * Vite/React build alike. See SPEC §5.
 */

export * from "./constants";
export * from "./protocol";
export * from "./ignore";
