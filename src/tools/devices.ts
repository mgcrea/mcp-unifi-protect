import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ProtectClient } from "../client/protect.js";
import {
  summarizeChime,
  summarizeEach,
  summarizeLight,
  summarizeSensor,
  summarizeViewer,
} from "../client/shape.js";
import type { ToolContext } from "./index.js";
import { compactOrUndefined, wrap } from "./util.js";

type Rec = Record<string, unknown>;

const idArg = (kind: string, listTool: string) =>
  z.string().min(1).describe(`${kind} id — the \`id\` from ${listTool}.`);

export const registerDeviceTools = (
  server: McpServer,
  client: ProtectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_list_lights",
    {
      description:
        "List UniFi Protect floodlights with their connection state, whether the light is " +
        "currently on, whether PIR motion is being detected, and brightness.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("lights"), summarizeLight)),
  );

  server.registerTool(
    "unifi_protect_list_sensors",
    {
      description:
        "List UniFi Protect sensors with their current readings — temperature, humidity, light " +
        "level — plus open/closed state, motion, and battery percentage. The readings are " +
        "lifted out of the console's per-metric history arrays, which are far larger than the " +
        "values themselves.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("sensors"), summarizeSensor)),
  );

  server.registerTool(
    "unifi_protect_list_viewers",
    {
      description:
        "List UniFi Protect Viewport devices and which live view each is currently displaying.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("viewers"), summarizeViewer)),
  );

  server.registerTool(
    "unifi_protect_list_chimes",
    {
      description:
        "List UniFi Protect chimes, their volume, and which doorbell cameras each is paired to.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("chimes"), summarizeChime)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "unifi_protect_update_light",
    {
      description:
        "Change a floodlight's settings — brightness, whether the light is on, and the PIR " +
        "sensitivity that decides when it triggers. Only the fields you pass are sent.",
      inputSchema: {
        lightId: idArg("Light", "unifi_protect_list_lights"),
        isLightOn: z.boolean().optional().describe("Turn the light on or off right now."),
        ledLevel: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe("Brightness, 1 (dimmest) to 6 (brightest)."),
        pirSensitivity: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Motion sensitivity, 0-100. Higher triggers on smaller movement."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ lightId, isLightOn, ledLevel, pirSensitivity }) =>
      wrap(async () => {
        const lightOnSettings = compactOrUndefined({ isLedForceOn: isLightOn });
        const lightDeviceSettings = compactOrUndefined({ ledLevel, pirSensitivity });
        const body = compactOrUndefined({ lightOnSettings, lightDeviceSettings });
        if (!body) {
          throw new Error(
            "Nothing to update — pass at least one of isLightOn, ledLevel, pirSensitivity.",
          );
        }
        return summarizeLight(
          await client.patch<Rec>(`lights/${encodeURIComponent(lightId)}`, body),
        );
      }),
  );

  server.registerTool(
    "unifi_protect_update_sensor",
    {
      description:
        "Rename a sensor or change which of its capabilities are enabled. Only the fields you " +
        "pass are sent.",
      inputSchema: {
        sensorId: idArg("Sensor", "unifi_protect_list_sensors"),
        name: z.string().min(1).optional().describe("Display name for the sensor."),
        motionEnabled: z.boolean().optional().describe("Whether motion detection reports events."),
        temperatureEnabled: z.boolean().optional().describe("Whether temperature is reported."),
        humidityEnabled: z.boolean().optional().describe("Whether humidity is reported."),
        lightEnabled: z.boolean().optional().describe("Whether the light level is reported."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ sensorId, name, motionEnabled, temperatureEnabled, humidityEnabled, lightEnabled }) =>
      wrap(async () => {
        const body = compactOrUndefined({
          name,
          motionSettings: compactOrUndefined({ isEnabled: motionEnabled }),
          temperatureSettings: compactOrUndefined({ isEnabled: temperatureEnabled }),
          humiditySettings: compactOrUndefined({ isEnabled: humidityEnabled }),
          lightSettings: compactOrUndefined({ isEnabled: lightEnabled }),
        });
        if (!body) {
          throw new Error(
            "Nothing to update — pass at least one of name, motionEnabled, temperatureEnabled, " +
              "humidityEnabled, lightEnabled.",
          );
        }
        return summarizeSensor(
          await client.patch<Rec>(`sensors/${encodeURIComponent(sensorId)}`, body),
        );
      }),
  );

  server.registerTool(
    "unifi_protect_update_viewer",
    {
      description:
        "Put a saved live view on a Viewport screen, or rename the viewer. The liveview id " +
        "comes from unifi_protect_list_liveviews — this changes what is displayed on a physical " +
        "screen, so someone watching will see it switch.",
      inputSchema: {
        viewerId: idArg("Viewer", "unifi_protect_list_viewers"),
        liveview: z
          .string()
          .min(1)
          .optional()
          .describe("Live view id from unifi_protect_list_liveviews — the layout to display."),
        name: z.string().min(1).optional().describe("Display name for the viewer."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ viewerId, liveview, name }) =>
      wrap(async () => {
        const body = compactOrUndefined({ liveview, name });
        if (!body) throw new Error("Nothing to update — pass liveview or name.");
        return summarizeViewer(
          await client.patch<Rec>(`viewers/${encodeURIComponent(viewerId)}`, body),
        );
      }),
  );

  server.registerTool(
    "unifi_protect_update_chime",
    {
      description:
        "Change a chime's volume or rename it. Volume 0 silences it, so a doorbell press will " +
        "make no sound.",
      inputSchema: {
        chimeId: idArg("Chime", "unifi_protect_list_chimes"),
        volume: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Volume, 0-100. 0 means the chime stays silent when the doorbell is pressed."),
        name: z.string().min(1).optional().describe("Display name for the chime."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ chimeId, volume, name }) =>
      wrap(async () => {
        const body = compactOrUndefined({ volume, name });
        if (!body) throw new Error("Nothing to update — pass volume or name.");
        return summarizeChime(
          await client.patch<Rec>(`chimes/${encodeURIComponent(chimeId)}`, body),
        );
      }),
  );
};
