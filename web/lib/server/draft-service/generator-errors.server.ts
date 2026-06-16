import "server-only";

// Map a `DraftGeneratorError` to the route's stable HTTP error shape. The
// service catches `DraftGeneratorError` so the route can return a clean
// `{ error }` JSON without ever surfacing provider URLs, status codes, or
// stack traces to the client.

import type { DraftGeneratorError } from "@/lib/server/draft-generator/index.server";
import type { DraftServiceResult } from "./types";

export function generatorErrorToServiceResult(
  error: DraftGeneratorError,
): DraftServiceResult {
  // Log the precise reason server-side so an operator can debug, but keep
  // the user-facing message blame-free and identical to the existing route
  // contract.
  console.error(`DraftGeneratorError(${error.kind}): ${error.message}`);

  switch (error.kind) {
    case "misconfigured":
      return {
        ok: false,
        status: 500,
        error: "Draft generator is misconfigured",
      };
    case "unavailable":
      return {
        ok: false,
        status: 500,
        error: "Draft generator is unavailable",
      };
    case "malformed_response":
      return {
        ok: false,
        status: 500,
        error: "Draft generator returned an unusable response",
      };
  }
}
