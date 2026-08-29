import { z } from "zod";

import {
  NotConfiguredError,
  ProtectApiError,
  ProtectAuthError,
  WritesDisabledError,
} from "../client/errors.js";

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof ProtectApiError) {
    return fail(err.message, {
      status: err.status,
      ...(err.path ? { path: err.path } : {}),
      errors: err.errors,
    });
  }
  if (err instanceof ProtectAuthError) {
    return fail(err.message, err.needsTwoFactor ? { needsTwoFactor: true } : undefined);
  }
  if (err instanceof WritesDisabledError || err instanceof NotConfiguredError) {
    return fail(err.message);
  }
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (e.g. an image block). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** Drop undefined values so we never send `{"name": undefined}` to the console. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `{}` is not a no-op PATCH body — send undefined instead. */
export const compactOrUndefined = <T extends Record<string, unknown>>(
  obj: T,
): Partial<T> | undefined => {
  const out = compact(obj);
  return Object.keys(out).length > 0 ? out : undefined;
};

const RELATIVE =
  /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)(?:\s+ago)?$/i;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Convert a time expression to milliseconds since the Unix epoch.
 *
 * This exists because the console's `/events` endpoint takes JavaScript
 * millisecond timestamps — not ISO 8601, and NOT Unix seconds. A seconds value
 * is not rejected: it is interpreted as a moment in January 1970, so the query
 * succeeds and returns an empty list. That reads as "nothing happened last
 * night", which is the most expensive possible failure for this server.
 *
 * Accepts ISO 8601, a relative expression like "2h ago" or "30m", the literal
 * "now", or a raw millisecond number.
 */
export const toEpochMs = (value: string | number, now: number = Date.now()): number => {
  if (typeof value === "number") return Math.round(value);

  const text = value.trim();
  if (text === "" || text.toLowerCase() === "now") return now;

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase()[0]!;
    const scale = UNIT_MS[unit];
    if (scale === undefined) {
      throw new Error(`Unrecognised time unit in "${value}".`);
    }
    return Math.round(now - amount * scale);
  }

  // A bare number in a string is milliseconds, but a 10-digit one is almost
  // certainly seconds that someone converted by hand. Catch it rather than
  // silently querying 1970.
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (text.length <= 10) {
      throw new Error(
        `"${value}" looks like Unix SECONDS. This API takes milliseconds — pass ${n * 1000}, ` +
          `or better, an ISO 8601 timestamp or a relative expression like "2h ago".`,
      );
    }
    return n;
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Could not read "${value}" as a time. Use ISO 8601 (2026-08-29T22:00:00Z), a relative ` +
        `expression ("2h ago", "30m", "7d"), or "now".`,
    );
  }
  return parsed;
};

export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes the console's state.");

export const cameraIdArg = z
  .string()
  .min(1)
  .describe(
    "Camera id — the `id` from unifi_protect_list_cameras, a 24-character hex string. Not the " +
      "camera's name and not its MAC address.",
  );

/** The shared prose for every time argument, so the trap is stated everywhere it applies. */
const timeHelp = (role: string): string =>
  `${role} Accepts ISO 8601 ("2026-08-29T22:00:00Z"), a relative expression ("2h ago", ` +
  `"30m", "7d"), or "now". Converted to the millisecond epoch the console requires — do ` +
  `not pass Unix seconds, which would silently query 1970 and return nothing.`;

export const timeArg = (role: string) => z.string().optional().describe(timeHelp(role));

export const requiredTimeArg = (role: string) => z.string().min(1).describe(timeHelp(role));

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe(
    "Maximum number of items to return (1-500). Defaults to 50. A busy system logs thousands " +
      "of motion events a day, so raise this deliberately.",
  );
