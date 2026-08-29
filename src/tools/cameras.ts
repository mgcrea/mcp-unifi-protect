import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProtectClient } from "../client/protect.js";
import { summarizeCamera, summarizeEach } from "../client/shape.js";
import type { ToolContext } from "./index.js";
import { cameraIdArg, compactOrUndefined, confirmArg, ok, wrap, wrapResult } from "./util.js";

type Rec = Record<string, unknown>;

const RECORDING_MODES = ["always", "never", "detections", "schedule"] as const;

/** Filesystem-safe stem for a snapshot file, derived from the camera name. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "camera";

export const registerCameraTools = (
  server: McpServer,
  client: ProtectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_list_cameras",
    {
      description:
        "List every camera on the console with its id, name, connection state, recording mode, " +
        "firmware and what it can do (PTZ, package camera, smart detection, and which object " +
        "types it detects). Returns a summary rather than the console's full camera record, " +
        "which runs to thousands of fields across encoder profiles, zones and feature flags — " +
        "use unifi_protect_get_camera when you need all of it for one camera.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("cameras"), summarizeCamera)),
  );

  server.registerTool(
    "unifi_protect_get_camera",
    {
      description:
        "Get one camera's complete record — every setting the console holds, including encoder " +
        "channels, motion and smart-detection zones, privacy masks, OSD and LED settings, ISP " +
        "tuning and live statistics. This is large (roughly 8-15 KB of JSON). Prefer " +
        "unifi_protect_list_cameras unless you specifically need a field it does not carry.",
      inputSchema: { cameraId: cameraIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ cameraId }) => wrap(() => client.get(`cameras/${encodeURIComponent(cameraId)}`)),
  );

  server.registerTool(
    "unifi_protect_get_camera_snapshot",
    {
      description:
        "Capture a still frame from a camera as it looks right now. Writes the JPEG to disk and " +
        'returns its path, size and content type by default. Set output="image" to get the ' +
        "frame inline instead so a vision model can actually look at it — that costs roughly " +
        "300,000 to 700,000 characters of context per call, so choose it deliberately rather " +
        "than by default. A fresh capture is forced; without that the console can hand back a " +
        "cached frame that is minutes old.",
      inputSchema: {
        cameraId: cameraIdArg,
        output: z
          .enum(["file", "image"])
          .default("file")
          .describe(
            'Where the frame goes. "file" writes it to disk and returns the path — cheap, and ' +
              'you can read the file later if it turns out to matter. "image" returns it inline ' +
              "for a model to look at, at a large cost in context.",
          ),
        highQuality: z
          .boolean()
          .default(false)
          .describe(
            "Request the camera's full resolution rather than a scaled frame. Larger and slower; " +
              'with output="image" it multiplies an already expensive call.',
          ),
        savePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to write the JPEG to. Defaults to a timestamped file under " +
              "UNIFI_PROTECT_SNAPSHOT_DIR. Parent directories are created.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cameraId, output, highQuality, savePath }) =>
      wrapResult(async () => {
        const { bytes, contentType } = await client.requestBytes(
          `cameras/${encodeURIComponent(cameraId)}/snapshot`,
          {
            query: {
              // Without force=true the console may return the last frame it
              // happens to have cached, which can be minutes stale — and a
              // stale frame is indistinguishable from a current one.
              force: "true",
              ...(highQuality ? { highQuality: "true" } : {}),
              ts: Date.now(),
            },
            accept: "image/jpeg",
          },
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

        const cameras = await ctx.devices.cameras();
        const name = cameras.get(cameraId) ?? cameraId;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = savePath ?? join(ctx.config.snapshotDir, `${slug(name)}-${stamp}.jpg`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, bytes);

        return ok({
          path,
          bytes: bytes.byteLength,
          contentType,
          camera: name,
          capturedAt: new Date().toISOString(),
          note: 'Call again with output="image" if a model needs to see the frame itself.',
        });
      }),
  );

  server.registerTool(
    "unifi_protect_list_ptz_presets",
    {
      description:
        "List a PTZ camera's saved preset positions, with the slot number each one lives at. " +
        "Only meaningful for cameras reporting hasPtz: true in unifi_protect_list_cameras. " +
        "There is no tool to MOVE a PTZ camera or run a patrol: those commands exist only on " +
        "Ubiquiti's official Integration API (a separate X-API-KEY auth this server does not " +
        "use), not on the private API this server wraps — presets are created and driven from " +
        "the Protect app itself.",
      inputSchema: { cameraId: cameraIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ cameraId }) =>
      wrap(() => client.get(`cameras/${encodeURIComponent(cameraId)}/ptz/preset`)),
  );

  server.registerTool(
    "unifi_protect_list_ptz_patrols",
    {
      description:
        "List a PTZ camera's saved patrol routes. See unifi_protect_list_ptz_presets for why " +
        "there is no tool to start or stop one.",
      inputSchema: { cameraId: cameraIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ cameraId }) =>
      wrap(() => client.get(`cameras/${encodeURIComponent(cameraId)}/ptz/patrol`)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "unifi_protect_update_camera",
    {
      description:
        "Change a camera's settings in place. Only the fields you pass are sent; everything " +
        "else is left as it is. Use unifi_protect_set_camera_recording_mode for recording mode " +
        "alone — it is the setting people mean most often and it is easy to send wrongly here.",
      inputSchema: {
        cameraId: cameraIdArg,
        name: z.string().min(1).optional().describe("Display name shown throughout Protect."),
        micVolume: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Microphone sensitivity, 0-100. 0 mutes the microphone."),
        isMicEnabled: z.boolean().optional().describe("Whether the microphone records at all."),
        ledLevel: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Status LED brightness, 0 (off) to 6."),
        isLedForced: z.boolean().optional().describe("Keep the status LED on regardless of state."),
        osdName: z.boolean().optional().describe("Overlay the camera name on the video."),
        osdDate: z.boolean().optional().describe("Overlay the date and time on the video."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ cameraId, name, micVolume, isMicEnabled, ledLevel, isLedForced, osdName, osdDate }) =>
      wrap(async () => {
        const ledSettings = compactOrUndefined({ isLedForced });
        const osdSettings = compactOrUndefined({ isNameEnabled: osdName, isDateEnabled: osdDate });
        const body = compactOrUndefined({
          name,
          micVolume,
          isMicEnabled,
          ledLevel,
          ledSettings,
          osdSettings,
        });
        if (!body) {
          throw new Error(
            "Nothing to update — pass at least one of name, micVolume, isMicEnabled, ledLevel, " +
              "isLedForced, osdName, osdDate.",
          );
        }
        return summarizeCamera(
          await client.patch<Rec>(`cameras/${encodeURIComponent(cameraId)}`, body),
        );
      }),
  );

  server.registerTool(
    "unifi_protect_set_camera_recording_mode",
    {
      description:
        "Set what a camera records. `never` stops recording entirely — the camera stays online " +
        "and streams live, but nothing is written, so there will be no footage to search later. " +
        "`detections` records only motion and smart detections; `always` records continuously; " +
        "`schedule` follows the schedule configured in Protect.",
      inputSchema: {
        cameraId: cameraIdArg,
        mode: z
          .enum(RECORDING_MODES)
          .describe(
            "Recording mode. `never` means no footage is kept from now on — this is the one " +
              "worth pausing over.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ cameraId, mode }) =>
      wrap(async () =>
        summarizeCamera(
          await client.patch<Rec>(`cameras/${encodeURIComponent(cameraId)}`, {
            recordingSettings: { mode },
          }),
        ),
      ),
  );

  server.registerTool(
    "unifi_protect_reboot_camera",
    {
      description:
        "Reboot a camera. It stops recording and goes offline for roughly a minute, and any " +
        "footage during that window is lost. Useful for a camera that has stopped responding.",
      inputSchema: { cameraId: cameraIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ cameraId }) =>
      wrap(() => client.post(`cameras/${encodeURIComponent(cameraId)}/reboot`)),
  );
};
