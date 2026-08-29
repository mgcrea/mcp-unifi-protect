import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WritesDisabledError } from "../client/errors.js";
import type { ProtectClient } from "../client/protect.js";
import { wrap } from "./util.js";

/**
 * Reject anything that is not a plain relative path. The server decides the
 * host and the `/proxy/protect/api` prefix; letting a caller supply either
 * would send the console session somewhere it does not belong.
 */
export const assertSafePath = (path: string): void => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error("`path` must be a path, not an absolute URL — the server sets the host.");
  }
  if (path.split("/").includes("..")) {
    throw new Error("`path` must not contain `..` segments.");
  }
};

export const registerRequestTool = (
  server: McpServer,
  client: ProtectClient,
  allowWrites: boolean,
): void => {
  const methods = allowWrites ? (["GET", "POST", "PATCH", "DELETE"] as const) : (["GET"] as const);

  server.registerTool(
    "unifi_protect_request",
    {
      description:
        "Escape hatch: call any private Protect API endpoint directly, relative to " +
        "/proxy/protect/api. This exists because the private API is undocumented and Ubiquiti " +
        "moves endpoints between Protect releases — when a wrapped tool starts returning 404, " +
        "this reaches the replacement without waiting for a new version of this server. " +
        "Responses are returned RAW and unshaped, so a broad endpoint like `bootstrap` can " +
        "return hundreds of kilobytes; prefer the wrapped tools, which summarize. " +
        (allowWrites
          ? "Writes are ENABLED, so POST, PATCH and DELETE are permitted — there is no " +
            "confirmation step here, so check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set UNIFI_PROTECT_ALLOW_WRITES=1 to " +
            "allow mutations."),
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Path relative to /proxy/protect/api, without a leading slash, e.g. "cameras", ' +
              '"nvr", "events/abc123". Not an absolute URL.',
          ),
        method: z.enum(methods).default("GET").describe("HTTP method."),
        query: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Query parameters as a flat string map, e.g. {"start":"1756500000000"}. Remember ' +
              "that Protect times are milliseconds since the epoch.",
          ),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON request body, for POST and PATCH."),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ path, method, query, body }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes writes, but a client could
        // hand-roll a request that skips schema validation entirely.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`unifi_protect_request with method ${method}`);
        }
        assertSafePath(path);
        return client.request(method, path, {
          ...(query ? { query } : {}),
          ...(body ? { body } : {}),
        });
      }),
  );
};
