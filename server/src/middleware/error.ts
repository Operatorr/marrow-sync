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

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "ApiException";
    this.status = status;
    this.code = code;
  }
}

/** Convenience constructors for the common failure modes. */
export const errors = {
  unauthorized: (message = "Authentication required") =>
    new ApiException(401, "unauthorized", message),
  forbidden: (message = "Forbidden") => new ApiException(403, "forbidden", message),
  notFound: (message = "Not found") => new ApiException(404, "not_found", message),
  badRequest: (message = "Bad request") => new ApiException(400, "bad_request", message),
  conflict: (message = "Conflict") => new ApiException(409, "conflict", message),
} as const;

/** Hono `onError` handler: collapse any thrown value into the `ApiError` shape. */
export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiException) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    return c.json(body, err.status);
  }
  if (err instanceof HTTPException) {
    const body: ApiError = { error: { code: "http_error", message: err.message } };
    return c.json(body, err.status);
  }
  const body: ApiError = { error: { code: "internal", message: "Internal server error" } };
  return c.json(body, 500);
}
