// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Marrow server entry — Hono on Cloudflare Workers (SPEC §7).
 *
 * Everything is mounted under `/api`. `/api/auth/*` is delegated to better-auth;
 * all other routes require authentication (device token or session) and are
 * chained into a single route object whose type is exported as {@link AppType}
 * for the client's typed RPC (`hono/client`). Because `AppType` is a type-only
 * import on the client, no server code ships in the client bundle (SPEC §5).
 */

import { API_BASE } from "@marrow/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { getAuth } from "./auth";
import { type AppBindings } from "./env";
import { requireAuth } from "./middleware/auth";
import { onError } from "./middleware/error";
import { changes } from "./routes/changes";
import { chunks } from "./routes/chunks";
import { devices } from "./routes/devices";
import { roots } from "./routes/roots";

/**
 * Origins the Tauri client calls the Worker from. The webview is a different
 * origin than the API, so JSON POSTs carrying an `Authorization` header trigger a
 * CORS preflight that must be answered or the browser-context `fetch` fails
 * before the request is sent. The scheme/host differs per platform (SPEC §5):
 *   - `tauri://localhost`       macOS / iOS webview
 *   - `https://tauri.localhost` Windows (WebView2)
 *   - `http://tauri.localhost`  Linux (WebKitGTK)
 *   - `http://localhost:1420`   Vite dev server (`tauri dev`)
 */
const ALLOWED_ORIGINS = [
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
];

const app = new Hono<AppBindings>().basePath(API_BASE);

app.onError(onError);

// Answer CORS preflight + reflect allowed origins for every route (incl. /auth/*).
// Credentials are enabled for the cookie-based session path; the device-token
// path is bearer-only and unaffected by it.
app.use(
  "*",
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    credentials: true,
    maxAge: 86400,
  }),
);

// better-auth handles its own routes (OAuth, session) — must precede requireAuth.
app.on(["GET", "POST"], "/auth/*", (c) => getAuth(c.env).handler(c.req.raw));

// Health check (unauthenticated).
app.get("/health", (c) => c.json({ ok: true }));

// Everything below requires an authenticated caller.
app.use("/devices/*", requireAuth);
app.use("/roots/*", requireAuth);
app.use("/chunks/*", requireAuth);

// The chained route object exists only to derive `AppType` for the client's RPC
// (`hono/client`); the running app is the `app` default export. The value is
// intentionally type-only here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const routes = app
  .route("/devices", devices)
  .route("/roots", roots)
  .route("/roots", changes)
  .route("/chunks", chunks);

/** The chained app type the client imports for end-to-end-typed RPC (SPEC §5). */
export type AppType = typeof routes;

export default app;
