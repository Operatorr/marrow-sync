// SPDX-License-Identifier: AGPL-3.0-only

// The client imports `type { AppType }` from "@marrow/server" to build a typed
// hono/client RPC (SPEC §5). That type-only import pulls the server's source
// module graph into this program for type resolution, which references the
// Cloudflare Worker globals (`D1Database`, `R2Bucket`) from its `env.ts`.
//
// We load `@cloudflare/workers-types` via a triple-slash reference here — scoped
// to this declaration file rather than the project-wide `types` array — so those
// ambient globals resolve without dropping `vite/client` or the DOM lib the UI
// depends on. No server runtime code ships in the client bundle; this is purely
// for compile-time type resolution.

/// <reference types="@cloudflare/workers-types" />

export {};
