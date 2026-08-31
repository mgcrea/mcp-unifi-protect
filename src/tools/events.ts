import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProtectClient } from "@mgcrea/unifi-protect";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { detectionWarnings } from "#/client/detection";
import { resolveLocation } from "#/client/locations";
import { summarizeEvent } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  cameraIdArg,
  limitArg,
  localTime,
  fail,
  ok,
  requiredTimeArg,
  timeArg,
  toEpochMs,
  type ToolResult,
  wrap,
  wrapResult,
} from "#/tools/util";

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
      title: "UniFi Protect: List Events",
      description:
        "Search recorded events over any time range — motion, smart detections (person, " +
        "vehicle, animal, package, licence plate), doorbell rings, and camera connection " +
        'changes. This is the tool for questions like "what happened at the front door last ' +
        "night\". Each result carries its camera's NAME as well as its id, so no second lookup " +
        'is needed. Times may be given in the console\'s own local clock ("1am"), which is ' +
        "what a question about last night means. READ ANY `warnings` IN THE RESULT BEFORE " +
        "REPORTING A COUNT: a camera with the detector switched off returns zero matches, " +
        "which is not the same as nothing having happened, and this tool says which case it " +
        "is. Narrow with `types`, `smartDetectTypes` and `cameraIds` wherever you can: a busy " +
        "system logs thousands of motion events a day.",
      inputSchema: z.object({
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
            "Restrict to one camera — the `id` from unifi_protect_list_cameras. Omit for all " +
              "cameras. Use cameraIds for several.",
          ),
        cameraIds: z
          .array(cameraIdArg)
          .optional()
          .describe(
            "Restrict to several cameras by id. Filtering happens on the console, so a narrow " +
              "camera list over a long window returns that camera's events rather than " +
              "whatever survived a fleet-wide limit.",
          ),
        location: z
          .string()
          .optional()
          .describe(
            'A configured place name, e.g. "front". Resolves to the cameras covering it — the ' +
              "console has no idea where anything is, so this comes from " +
              "UNIFI_PROTECT_LOCATIONS. Read unifi-protect://locations to see what is defined.",
          ),
        limit: limitArg,
        order: z
          .enum(["newest", "oldest"])
          .default("newest")
          .describe("Which end of the window to return first."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end, types, smartDetectTypes, cameraId, cameraIds, location, limit, order }) =>
      wrap(async () => {
        const facts = await ctx.devices.facts();

        // Resolve the scope first: the time window's local interpretation does
        // not depend on it, but every warning below does.
        const scope = new Set<string>([
          ...(cameraId ? [cameraId] : []),
          ...(cameraIds ?? []),
          ...(location ? resolveLocation(location, ctx.config.locations, facts).ids : []),
        ]);
        const unmatched = location
          ? resolveLocation(location, ctx.config.locations, facts).unmatched
          : [];

        // "1am" means 1am WHERE THE CAMERAS ARE. Falling back to this process's
        // zone would quietly return a different night's footage.
        const timeZone = ctx.config.timeZone ?? (await ctx.devices.timeZone());

        // Default to the last 24 hours rather than whatever the console decides,
        // which is undocumented and has changed between releases.
        const endMs = end === undefined ? Date.now() : toEpochMs(end, { timeZone });
        // A bare time-of-day in `start` anchors to the window's END, so
        // "1am to 6am" is one coherent night however late it is asked.
        const startMs =
          start === undefined ? endMs - 86_400_000 : toEpochMs(start, { timeZone, before: endMs });

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
          // Filtered ON THE CONSOLE. This was once done client-side, on the
          // belief that the endpoint had no camera filter — it does, and the
          // difference matters: filtering after the fact fetches the newest
          // `limit` events across ALL cameras and then discards most of them,
          // so a quiet camera over a long window came back empty while
          // reporting a successful search. `cameras` must be REPEATED per id;
          // a comma-separated list is accepted and silently matches nothing.
          ...(scope.size > 0 ? { cameras: [...scope] } : {}),
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
          .map((e) => summarizeEvent(e, cameras, timeZone));

        // The cameras the answer actually depends on: the requested scope, or
        // every smart-capable camera when the search was fleet-wide.
        const searched =
          scope.size > 0
            ? [...scope].flatMap((id) => {
                const f = facts.get(id);
                return f ? [f] : [];
              })
            : [...facts.values()].filter((f) => f.hasSmartDetect);

        const warnings = [
          ...detectionWarnings(smartDetectTypes ?? [], searched),
          ...(unmatched.length > 0
            ? [
                `Location "${location}" lists ${unmatched.map((u) => `"${u}"`).join(", ")}, ` +
                  `which matched no camera. Check UNIFI_PROTECT_LOCATIONS against ` +
                  `unifi_protect_list_cameras.`,
              ]
            : []),
          ...(timeZone === undefined
            ? [
                "The console's time zone could not be read, so times were interpreted as UTC. " +
                  "Set UNIFI_PROTECT_TIMEZONE if local times matter.",
              ]
            : []),
        ];

        return {
          window: {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
            ...(timeZone
              ? {
                  timeZone,
                  localStart: localTime(startMs, timeZone),
                  localEnd: localTime(endMs, timeZone),
                }
              : {}),
          },
          types: requestedTypes,
          ...(scope.size > 0 ? { cameras: [...scope].map((id) => facts.get(id)?.name ?? id) } : {}),
          count: shaped.length,
          // Say so when the limit was the binding constraint, rather than
          // letting a truncated list read as a complete one.
          ...(events.length >= limit
            ? {
                truncated: true,
                note: `Returned the ${order === "newest" ? "newest" : "oldest"} ${limit} events; more exist in this window. Narrow the range or raise limit.`,
              }
            : {}),
          // Before the count, because the count alone is misleading when a
          // detector was off and this is the only thing that says so.
          ...(warnings.length > 0 ? { warnings } : {}),
          events: shaped,
        };
      }),
  );

  server.registerTool(
    "unifi_protect_get_event",
    {
      title: "UniFi Protect: Get Event",
      description:
        "Get one event's full record, including detection metadata the search results leave " +
        "out — per-object tracking, detected zones, licence plate text and vehicle attributes " +
        "where the camera captured them. Use the `id` from unifi_protect_list_events.",
      inputSchema: z.object({
        eventId: z.string().min(1).describe("Event id — the `id` from unifi_protect_list_events."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ eventId }) => wrap(() => client.get(`events/${encodeURIComponent(eventId)}`)),
  );

  server.registerTool(
    "unifi_protect_get_event_thumbnail",
    {
      title: "UniFi Protect: Get Event Thumbnail",
      description:
        "Fetch the still image Protect captured for an event — the frame that triggered the " +
        'detection. Writes it to disk and returns the path by default; set output="image" to ' +
        "return it inline for a vision model to look at, which costs a large amount of context. " +
        "Pass the event's `id` from unifi_protect_list_events; results showing " +
        "`hasThumbnail: true` have one.",
      inputSchema: z.object({
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
      }),
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
    "unifi_protect_get_event_thumbnails",
    {
      title: "UniFi Protect: Get Event Thumbnails",
      description:
        "Fetch the still frames for SEVERAL events at once and return them inline to look at. " +
        "This is the tool for answering who or what was actually there, and it matters most " +
        "when a camera has no smart detection: motion events carry no classification, so the " +
        "only way to tell a person from a branch is to look. Prefer this over calling " +
        "unifi_protect_get_event_thumbnail repeatedly. Costs roughly 1-2K tokens per image, so " +
        "it is capped at 6 — pick the events worth seeing from unifi_protect_list_events " +
        "rather than sweeping a whole night. Events that have no thumbnail are reported by id " +
        "instead of failing the call.",
      inputSchema: z.object({
        eventIds: z
          .array(z.string().min(1))
          .min(1)
          .max(6)
          .describe(
            "Event ids from unifi_protect_list_events, at most 6. Results showing " +
              "`hasThumbnail: true` have an image.",
          ),
        output: z
          .enum(["image", "file"])
          .default("image")
          .describe(
            '"image" returns the frames inline for a vision model to look at, which is the ' +
              'point of this tool; "file" writes them to disk and returns paths instead.',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ eventIds, output }) =>
      wrapResult(async () => {
        const content: ToolResult["content"] = [];
        const failed: { eventId: string; reason: string }[] = [];
        const paths: { eventId: string; path: string; bytes: number }[] = [];

        for (const eventId of eventIds) {
          const id = eventId.startsWith("e-") ? eventId.slice(2) : eventId;
          try {
            const { bytes, contentType } = await client.requestBytes(
              `events/${encodeURIComponent(id)}/thumbnail`,
              { accept: "image/jpeg" },
            );
            if (output === "image") {
              // Label each frame, or six images arrive with nothing saying
              // which event each one belongs to.
              content.push({ type: "text", text: `event ${id}` });
              content.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: contentType.startsWith("image/") ? contentType : "image/jpeg",
              });
            } else {
              const path = join(ctx.config.snapshotDir, `event-${slugId(id)}.jpg`);
              await mkdir(join(path, ".."), { recursive: true });
              await writeFile(path, bytes);
              paths.push({ eventId: id, path, bytes: bytes.byteLength });
            }
          } catch (err) {
            // One missing thumbnail must not lose the five that worked.
            failed.push({ eventId: id, reason: err instanceof Error ? err.message : String(err) });
          }
        }

        if (output === "file") {
          return ok({ saved: paths, ...(failed.length > 0 ? { failed } : {}) });
        }
        if (failed.length > 0) {
          content.push({
            type: "text",
            text: JSON.stringify({ failed }, null, 2),
          });
        }
        if (content.length === 0) {
          return fail("No thumbnail could be fetched for any of those events.", { failed });
        }
        return { content };
      }),
  );

  server.registerTool(
    "unifi_protect_export_video",
    {
      title: "UniFi Protect: Export Video",
      description:
        "Export recorded footage from one camera over a time range as an MP4 file on disk. " +
        "Always writes to a file and returns the path — video is never returned inline. Size " +
        "grows quickly with the window: expect tens of megabytes per minute at full quality, " +
        "and the call fails rather than exhausting memory if the export exceeds " +
        "UNIFI_PROTECT_MAX_DOWNLOAD_BYTES. Footage only exists if the camera was recording at " +
        "the time, so check the recording mode before concluding that nothing happened.",
      inputSchema: z.object({
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
      }),
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
