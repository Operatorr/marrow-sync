// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The typed server RPC client (SPEC §5). We import the server's Hono `AppType`
 * (type-only, so no server code ships in this bundle) and build a fully-typed
 * `hc` client: changing an endpoint on the server makes this fail to compile
 * until the caller is fixed.
 *
 * The base URL comes from settings (`Settings.serverUrl`) and is validated +
 * normalized (`normalizeServerUrl`) so the long-lived device token (SPEC §10) is
 * never sent to an arbitrary or cleartext origin. The caller supplies that token
 * — sourced from the OS keychain on the Rust side — and this module only attaches
 * it as a bearer header; it never reads, persists, or rotates it.
 *
 * NOTE: `hono/client` (`hc`) does NOT throw on a non-2xx response — it resolves
 * with the `Response` and leaves status handling to the caller. Use {@link unwrap}
 * to turn a non-2xx `ApiError` envelope into a typed {@link ServerError}.
 */

import { hc } from "hono/client";

import type { ApiError } from "@marrow/shared";
import type { AppType } from "@marrow/server";

import { normalizeServerUrl } from "../lib/serverUrl";

/** A device token, or a getter for it (so a rotated/cleared token isn't stale). */
export type DeviceTokenSource = string | null | (() => string | null);

/** Options for constructing a server client. */
export interface ServerClientOptions {
  /** Base URL of the Marrow server, e.g. `https://api.marrow.dev`. */
  serverUrl: string;
  /**
   * Device token for the `Authorization: Bearer …` header, if signed in. May be a
   * function, which is re-read on every request so a rotated/cleared token (from
   * the Rust keychain) is never captured stale.
   */
  deviceToken?: DeviceTokenSource;
  /** Override fetch (used in tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The shape `hc<AppType>` produces — exported so callers can annotate. */
export type ServerClient = ReturnType<typeof hc<AppType>>;

/** Resolve a {@link DeviceTokenSource} to a concrete token (or null). */
function resolveToken(source: DeviceTokenSource | undefined): string | null {
  if (typeof source === "function") return source();
  return source ?? null;
}

/**
 * Build a typed RPC client bound to a validated server URL and (optionally) a
 * device token. The URL is parsed and normalized by {@link normalizeServerUrl},
 * which throws on a cleartext non-loopback origin or a URL carrying a query or
 * fragment, so the bearer token can never leak to an unintended destination.
 */
export function createServerClient(options: ServerClientOptions): ServerClient {
  const { serverUrl, deviceToken, fetch: fetchImpl } = options;
  const baseUrl = normalizeServerUrl(serverUrl);

  // `headers` as a function is re-invoked per request, so a token read here is
  // always current rather than frozen at construction time.
  const headers = (): Record<string, string> => {
    const token = resolveToken(deviceToken);
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  return hc<AppType>(baseUrl, {
    headers,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Thrown by {@link unwrap} when the server returns a non-2xx response. Carries the
 * HTTP `status` and the application `code` from the `ApiError` envelope so callers
 * can branch on a stable code rather than parsing a message.
 */
export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Read a JSON body from a `Response`, throwing a typed {@link ServerError} on a
 * non-2xx status. `hono/client` does not throw on non-2xx — it hands back the raw
 * `Response` — so every RPC call must funnel through here to surface server-side
 * failures as exceptions.
 *
 * On a non-2xx response we try to parse the uniform `ApiError` envelope
 * (`{ error: { code, message } }`); if the body isn't that shape we fall back to
 * a generic `http_<status>` code so the caller still gets a typed error.
 */
export async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  let code = `http_${res.status}`;
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Non-JSON or empty body — keep the generic code/message above.
  }
  throw new ServerError(res.status, code, message);
}
