import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProtectClient } from "../client/protect.js";
import { summarizeEvent } from "../client/shape.js";
import type { ToolContext } from "./index.js";
import {
  cameraIdArg,
  limitArg,
  ok,
  requiredTimeArg,
  timeArg,
  toEpochMs,
  wrap,
  wrapResult,
} from "./util.js";

type Rec = Record<string, unknown>;

/**
 * The event types worth searching. Protect emits far more — disk health,
 * firmware updates, adoption, connection churn — but they are noise in an
 * event search and swamp the interesting ones.
 */
const EVENT_TYPES = [
  "motion",
  "smartDetectZone",
  "smartDetectLine",
  "smartAudioDetect",
  "ring",
  "doorAccess",
  "nfcCardScanned",
  "fingerprintIdentified",
  "disconnect",
  "cameraConnected",
  "cameraDisconnected",
  "recordingDeleted",
] as const;

/**
 * The default set: what a person means by "what happened". Motion, anything the
 * camera classified, and doorbell rings — with the device-health chatter left out.
 */
const DEFAULT_EVENT_TYPES = [
  "motion",
  "smartDetectZone",
  "smartDetectLine",
  "smartAudioDetect",
  "ring",
] as const;

const SMART_DETECT_TYPES = [
  "person",
  "vehicle",
  "animal",
  "package",
  "licensePlate",
  "face",
  "alrmSmoke",
  "alrmCmonx",
  "alrmSiren",
  "alrmBabyCry",
  "alrmSpeak",
  "alrmBark",
  "alrmBurglar",
  "alrmCarHorn",
  "alrmGlassBreak",
] as const;

export const registerEventTools = (
  server: McpServer,
  client: ProtectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_list_events",
    {
      description:
        "Search recorded events over any time range — motion, smart detections (person, " +
        "vehicle, animal, package, licence plate), doorbell rings, and camera connection " +
        'changes. This is the tool for questions like "what happened at the front door last ' +
        "night\". Each result carries its camera's NAME as well as its id, so no second lookup " +
        "is needed. Narrow with `types`, `smartDetectTypes` and `cameraId` wherever you can: a " +
        "busy system logs thousands of motion events a day, and an unfiltered query returns " +
        "the newest slice of that rather than the interesting part.",
      inputSchema: {
        start: timeArg("Beginning of the search window."),
        end: timeArg("End of the search window."),
        types: z
          .array(z.enum(EVENT_TYPES))
          .optional()
          .describe(
            "Event types to include. Defaults to motion, smart detections and rings. " +
              "`smartDetectZone` is the object-detection type — pair it with smartDetectTypes " +
              "to ask for people or vehicles specifically.",
          ),
        smartDetectTypes: z
          .array(z.enum(SMART_DETECT_TYPES))
          .optional()
          .describe(
            'What the camera classified, e.g. ["person"] or ["vehicle","licensePlate"]. Only ' +
              "meaningful for smartDetectZone / smartDetectLine events; the alrm* values are " +
              "audio detections. Cameras without smart detection never produce these.",
          ),
        cameraId: cameraIdArg
          .optional()
          .describe(
            "Restrict to one camera — the `id` from unifi_protect_list_cameras. Omit for all cameras.",
          ),
        limit: limitArg,
        order: z
          .enum(["newest", "oldest"])
          .default("newest")
          .describe("Which end of the window to return first."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, types, smartDetectTypes, cameraId, limit, order }) =>
      wrap(async () => {
        // Default to the last 24 hours rather than whatever the console decides,
        // which is undocumented and has changed between releases.
        const endMs = end === undefined ? Date.now() : toEpochMs(end);
        const startMs = start === undefined ? endMs - 86_400_000 : toEpochMs(start);

        if (startMs >= endMs) {
          throw new Error(
            `The window is empty: start (${new Date(startMs).toISOString()}) is not before end ` +
              `(${new Date(endMs).toISOString()}).`,
          );
        }

        // `types` is ALWAYS sent, even when the caller passed none. Omitting it
        // triggers a pagination bug in Protect where the console ignores the
        // window and returns the wrong slice — a silently wrong answer rather
        // than an error. Sending an explicit list is the documented workaround.
        const requestedTypes = types && types.length > 0 ? types : [...DEFAULT_EVENT_TYPES];

        const raw = await client.get<unknown>("events", {
          start: startMs,
          end: endMs,
          limit,
          orderDirection: order === "newest" ? "DESC" : "ASC",
          types: [...requestedTypes],
          ...(smartDetectTypes && smartDetectTypes.length > 0
            ? { smartDetectTypes: [...smartDetectTypes] }
            : {}),
          // The console's own descriptions are long, redundant with the fields
          // already returned, and localised — pure token cost.
          withoutDescriptions: "true",
        });

        const cameras = await ctx.devices.cameras();
        const events = Array.isArray(raw) ? raw : [];
        const shaped = events
          .filter((e): e is Rec => typeof e === "object" && e !== null)
          // The API has no camera filter on this endpoint, so it is applied here.
          .filter((e) => cameraId === undefined || e.camera === cameraId)
          .map((e) => summarizeEvent(e, cameras));

        return {
          window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
          types: requestedTypes,
          count: shaped.length,
          // Say so when the limit was the binding constraint, rather than
          // letting a truncated list read as a complete one.
          ...(events.length >= limit
            ? {
                truncated: true,
                note: `Returned the ${order === "newest" ? "newest" : "oldest"} ${limit} events; more exist in this window. Narrow the range or raise limit.`,
              }
            : {}),
          events: shaped,
        };
      }),
  );

  server.registerTool(
    "unifi_protect_get_event",
    {
      description:
        "Get one event's full record, including detection metadata the search results leave " +
        "out — per-object tracking, detected zones, licence plate text and vehicle attributes " +
        "where the camera captured them. Use the `id` from unifi_protect_list_events.",
      inputSchema: {
        eventId: z.string().min(1).describe("Event id — the `id` from unifi_protect_list_events."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ eventId }) => wrap(() => client.get(`events/${encodeURIComponent(eventId)}`)),
  );

  server.registerTool(
    "unifi_protect_get_event_thumbnail",
    {
      description:
        "Fetch the still image Protect captured for an event — the frame that triggered the " +
        'detection. Writes it to disk and returns the path by default; set output="image" to ' +
        "return it inline for a vision model to look at, which costs a large amount of context. " +
        "Pass the event's `id` from unifi_protect_list_events; results showing " +
        "`hasThumbnail: true` have one.",
      inputSchema: {
        eventId: z
          .string()
          .min(1)
          .describe(
            "Event id — the `id` from unifi_protect_list_events. Results with " +
              "`hasThumbnail: true` have an image; others return 404. A raw `e-…` value from " +
              "the console's own payload is also accepted.",
          ),
        output: z
          .enum(["file", "image"])
          .default("file")
          .describe('"file" writes it to disk and returns the path; "image" returns it inline.'),
        savePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to write the JPEG to. Defaults to a file under " +
              "UNIFI_PROTECT_SNAPSHOT_DIR. Parent directories are created.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ eventId, output, savePath }) =>
      wrapResult(async () => {
        // The console reports an event's thumbnail as `e-<eventId>`, but that
        // form belongs to `thumbnails/<id>`; `events/<id>/thumbnail` wants the
        // bare event id. Strip the prefix so either value works rather than
        // making the caller know which endpoint this happens to use.
        const id = eventId.startsWith("e-") ? eventId.slice(2) : eventId;
        const { bytes, contentType } = await client.requestBytes(
          `events/${encodeURIComponent(id)}/thumbnail`,
          { accept: "image/jpeg" },
        );

        if (output === "image") {
          return {
            content: [
              {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: contentType.startsWith("image/") ? contentType : "image/jpeg",
              },
            ],
          };
        }

        const path = savePath ?? join(ctx.config.snapshotDir, `event-${slugId(id)}.jpg`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, bytes);
        return ok({ path, bytes: bytes.byteLength, contentType });
      }),
  );

  server.registerTool(
    "unifi_protect_export_video",
    {
      description:
        "Export recorded footage from one camera over a time range as an MP4 file on disk. " +
        "Always writes to a file and returns the path — video is never returned inline. Size " +
        "grows quickly with the window: expect tens of megabytes per minute at full quality, " +
        "and the call fails rather than exhausting memory if the export exceeds " +
        "UNIFI_PROTECT_MAX_DOWNLOAD_BYTES. Footage only exists if the camera was recording at " +
        "the time, so check the recording mode before concluding that nothing happened.",
      inputSchema: {
        cameraId: cameraIdArg,
        start: requiredTimeArg("Beginning of the footage to export."),
        end: requiredTimeArg("End of the footage to export."),
        savePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to write the MP4 to. Defaults to a timestamped file under " +
              "UNIFI_PROTECT_SNAPSHOT_DIR. Parent directories are created.",
          ),
        channel: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe(
            "Encoder channel: 0 is the high-quality stream, higher numbers are progressively " +
              "lower bitrate. Use a higher channel to keep a long export manageable.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cameraId, start, end, savePath, channel }) =>
      wrap(async () => {
        const startMs = toEpochMs(start);
        const endMs = toEpochMs(end);
        if (startMs >= endMs) {
          throw new Error(
            `The window is empty: start (${new Date(startMs).toISOString()}) is not before end ` +
              `(${new Date(endMs).toISOString()}).`,
          );
        }

        const { bytes, contentType } = await client.requestBytes("video/export", {
          query: { camera: cameraId, start: startMs, end: endMs, channel },
          accept: "video/mp4",
        });

        const cameras = await ctx.devices.cameras();
        const name = cameras.get(cameraId) ?? cameraId;
        const stamp = new Date(startMs).toISOString().replace(/[:.]/g, "-");
        const path = savePath ?? join(ctx.config.snapshotDir, `${slugId(name)}-${stamp}.mp4`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, bytes);

        return {
          path,
          bytes: bytes.byteLength,
          contentType,
          camera: name,
          window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
        };
      }),
  );
};

const slugId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "export";
