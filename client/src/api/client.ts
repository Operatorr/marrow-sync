// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The typed server RPC client (SPEC §5). We import the server's Hono `AppType`
 * (type-only, so no server code ships in this bundle) and build a fully-typed
 * `hc` client: changing an endpoint on the server makes this fail to compile
 * until the caller is fixed.
 *
 * The base URL comes from settings (`Settings.serverUrl`); sync calls authenticate
 * with the long-lived device token (SPEC §10), attached as a bearer header. The
 * raw token lives only in the OS keychain on the Rust side — the UI passes through
 * whatever the Rust layer hands it and never persists it itself.
 */

import { hc } from "hono/client";

import type { AppType } from "@marrow/server";

/** Options for constructing a server client. */
export interface ServerClientOptions {
  /** Base URL of the Marrow server, e.g. `http://localhost:8787`. */
  serverUrl: string;
  /** Device token for the `Authorization: Bearer …` header, if signed in. */
  deviceToken?: string | null;
  /** Override fetch (used in tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The shape `hc<AppType>` produces — exported so callers can annotate. */
export type ServerClient = ReturnType<typeof hc<AppType>>;

/**
 * Build a typed RPC client bound to a server URL and (optionally) a device token.
 * Trailing slashes on `serverUrl` are trimmed so route concatenation stays clean.
 */
export function createServerClient(options: ServerClientOptions): ServerClient {
  const { serverUrl, deviceToken, fetch: fetchImpl } = options;
  const baseUrl = serverUrl.replace(/\/+$/, "");

  const headers: Record<string, string> = {};
  if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;

  return hc<AppType>(baseUrl, {
    headers,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
