import type { ProtectClient } from "@mgcrea/unifi-protect";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  summarizeBootstrap,
  summarizeEach,
  summarizeLiveview,
  summarizeUser,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compactOrUndefined, confirmArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

export const registerSystemTools = (
  server: McpServer,
  client: ProtectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_get_system_info",
    {
      title: "UniFi Protect: Get System Info",
      description:
        "Overview of the console: model, Protect version, firmware, timezone, uptime, storage " +
        "use and how many devices of each type are adopted. Worth calling first on an unfamiliar " +
        "system. The reported Protect version matters: this server talks to Protect's private " +
        "API, which Ubiquiti changes between releases, so a version that differs from the one " +
        "in the README is the first thing to check if a tool starts returning 404.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeBootstrap(await client.get<Rec>("bootstrap"))),
  );

  server.registerTool(
    "unifi_protect_list_users",
    {
      title: "UniFi Protect: List Users",
      description:
        "List the accounts that can sign in to Protect, with their role and last login. Useful " +
        "for auditing who has access to the cameras.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("users"), summarizeUser)),
  );

  server.registerTool(
    "unifi_protect_list_liveviews",
    {
      title: "UniFi Protect: List Liveviews",
      description:
        "List the saved live views — the named camera grid layouts shown on viewers and in the " +
        "Protect app. The returned id is what unifi_protect_update_viewer needs to put a layout " +
        "on a screen.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => summarizeEach(await client.get("liveviews"), summarizeLiveview)),
  );

  if (!ctx.allowWrites) return;

  server.registerTool(
    "unifi_protect_update_nvr_settings",
    {
      title: "UniFi Protect: Update NVR Settings",
      description:
        "Change console-wide settings. `isRecordingDisabled` is the significant one: turning it " +
        "on stops recording on EVERY camera at once, so nothing is written until it is turned " +
        "back off. Only the fields you pass are sent.",
      inputSchema: z.object({
        name: z.string().min(1).optional().describe("Display name for the console."),
        timezone: z
          .string()
          .min(1)
          .optional()
          .describe('IANA timezone, e.g. "Europe/Paris". Affects event timestamps and schedules.'),
        isRecordingDisabled: z
          .boolean()
          .optional()
          .describe(
            "Disable recording across every camera. True means no footage is kept, system-wide.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ name, timezone, isRecordingDisabled }) =>
      wrap(async () => {
        const body = compactOrUndefined({ name, timezone, isRecordingDisabled });
        if (!body) {
          throw new Error(
            "Nothing to update — pass at least one of name, timezone, isRecordingDisabled.",
          );
        }
        return client.patch("nvr", body);
      }),
  );

  server.registerTool(
    "unifi_protect_reboot_nvr",
    {
      title: "UniFi Protect: Reboot NVR",
      description:
        "REBOOT THE CONSOLE. Every camera stops recording for the two to five minutes it takes " +
        "to come back, and footage from that window is lost permanently. This also drops the " +
        "network if the console is your router (a UDM or UDM Pro), taking down everything behind " +
        "it. Reboot a single unresponsive camera with unifi_protect_reboot_camera instead " +
        "wherever that would do.",
      inputSchema: z.object({ confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async () => wrap(() => client.post("nvr/reboot")),
  );
};
