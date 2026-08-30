import { z } from "zod";

import {
  NotConfiguredError,
  ProtectApiError,
  ProtectAuthError,
  WritesDisabledError,
} from "#/client/errors";

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
 * Resolve an IANA time zone's offset, in milliseconds, at a given instant.
 *
 * There is no built-in for this. Formatting the instant IN the zone and reading
 * the wall-clock fields back as if they were UTC gives the offset, which is the
 * standard trick and the only one that stays correct across DST.
 */
const zoneOffsetMs = (utcMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some locales render midnight as hour 24; `% 24` normalises it.
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour") % 24,
    field("minute"),
    field("second"),
  );
  return asUtc - utcMs;
};

/** Wall-clock fields in `timeZone` -> epoch milliseconds. */
const fromZoned = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number => {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes: the first offset is read at the wrong instant when the guess
  // lands on the far side of a DST transition, and re-reading at the corrected
  // instant settles it.
  const once = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(once, timeZone);
};

/** The wall-clock date in `timeZone` at a given instant. */
const zonedDateParts = (ms: number, timeZone: string): [number, number, number] => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return [field("year"), field("month"), field("day")];
};

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const NAIVE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_OF_DAY = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i;

export type TimeOptions = {
  now?: number;
  /**
   * The console's time zone. A bare "1am" means 1am WHERE THE CAMERAS ARE, not
   * wherever this process happens to run, and an hour's error silently returns
   * the wrong night's footage.
   */
  timeZone?: string;
  /**
   * A bare time-of-day resolves to its latest occurrence at or before this.
   * Event search passes the window's end here, so "1am to 6am" asked at 03:00
   * still resolves to one coherent night rather than an inverted window.
   */
  before?: number;
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
 * "now", a raw millisecond number, and — when a `timeZone` is supplied — naive
 * local forms: "2026-08-30 01:00", "2026-08-30", "01:00" and "1am". Naive forms
 * are read in the console's zone, because that is the zone the person asking is
 * thinking in.
 */
export const toEpochMs = (value: string | number, opts: number | TimeOptions = {}): number => {
  const {
    now = Date.now(),
    timeZone,
    before,
  }: TimeOptions = typeof opts === "number" ? { now: opts } : opts;

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

  if (timeZone) {
    const dt = NAIVE_DATETIME.exec(text);
    if (dt) {
      return fromZoned(
        Number(dt[1]),
        Number(dt[2]),
        Number(dt[3]),
        Number(dt[4]),
        Number(dt[5]),
        Number(dt[6] ?? 0),
        timeZone,
      );
    }

    const d = NAIVE_DATE.exec(text);
    if (d) {
      return fromZoned(Number(d[1]), Number(d[2]), Number(d[3]), 0, 0, 0, timeZone);
    }

    const tod = TIME_OF_DAY.exec(text);
    if (tod) {
      const meridiem = tod[4]?.toLowerCase();
      let hour = Number(tod[1]);
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      if (hour > 23) {
        throw new Error(`"${value}" is not a valid time of day.`);
      }
      const anchor = before ?? now;
      const [y, mo, day] = zonedDateParts(anchor, timeZone);
      const candidate = fromZoned(
        y,
        mo,
        day,
        hour,
        Number(tod[2] ?? 0),
        Number(tod[3] ?? 0),
        timeZone,
      );
      // "1am" asked at midday means this morning, not tomorrow morning.
      return candidate <= anchor ? candidate : candidate - 86_400_000;
    }
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Could not read "${value}" as a time. Use ISO 8601 (2026-08-29T22:00:00Z), a relative ` +
        `expression ("2h ago", "30m", "7d"), or "now"` +
        (timeZone
          ? `, or a local time in ${timeZone} ("2026-08-30 01:00", "1am").`
          : `. Local forms like "1am" need the console's time zone, which is unavailable here.`),
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

export { localTime } from "#/client/shape";
