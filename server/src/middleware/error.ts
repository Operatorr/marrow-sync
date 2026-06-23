// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uniform error envelope (matches the shared {@link ApiError} type).
 *
 * Routes throw {@link ApiException} with a machine code + HTTP status; the
 * `onError` handler renders every failure as `{ error: { code, message } }` so
 * the client can branch on a stable `code` rather than parse prose.
 */

import { type ApiError } from "@marrow/shared";
import { type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type ContentfulStatusCode } from "hono/utils/http-status";

/** A typed API failure carrying a stable machine code. */
export class ApiException extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiException";
    this.status = status;
    this.code = code;
  }
}

/** Stable machine codes for the common HTTP statuses Hono itself may throw. */
const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

/** Convenience constructors for the common failure modes. */
export const errors = {
  unauthorized: (message = "Authentication required") =>
    new ApiException(401, "unauthorized", message),
  forbidden: (message = "Forbidden") => new ApiException(403, "forbidden", message),
  notFound: (message = "Not found") => new ApiException(404, "not_found", message),
  badRequest: (message = "Bad request") => new ApiException(400, "bad_request", message),
  conflict: (message = "Conflict") => new ApiException(409, "conflict", message),
} as const;

/** Hono `onError` handler: collapse any thrown Error into the `ApiError` shape. */
export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiException) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    return c.json(body, err.status);
  }
  if (err instanceof HTTPException) {
    // Map to a stable code; for 5xx use a generic message so internal detail
    // from framework/middleware exceptions never leaks to the client.
    const code = STATUS_CODES[err.status] ?? "http_error";
    const message = err.status >= 500 ? "Internal server error" : err.message;
    if (err.status >= 500) console.error("HTTPException 5xx", err);
    const body: ApiError = { error: { code, message } };
    return c.json(body, err.status);
  }
  // Unexpected error: log the full value server-side (the only record of it on
  // Workers), but return a sanitized envelope so nothing internal is exposed.
  console.error("Unhandled error", err);
  const body: ApiError = { error: { code: "internal", message: "Internal server error" } };
  return c.json(body, 500);
}
