import type { McpServer } from "@modelcontextprotocol/server";

import { cameraFacts } from "#/client/detection";
import { availableLocations } from "#/client/locations";
import type { ProtectClient } from "#/client/protect";
import { summarizeNvr } from "#/client/shape";
import type { Config } from "#/config";

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (uri: URL, data: unknown) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    },
  ],
});

/**
 * Resources carry the standing facts a question needs before a tool is even
 * chosen — the console's time zone, what each camera will actually detect, and
 * which cameras count as "the front of the house".
 *
 * They are resources rather than tools because none of them is an action, and a
 * client can attach them once instead of spending a tool call per question. The
 * time zone in particular is a correctness matter: "1am" resolved in the wrong
 * zone returns a different hour's footage and nothing looks wrong.
 */
export const registerResources = (
  server: McpServer,
  client: ProtectClient,
  config: Config,
): void => {
  server.registerResource(
    "console",
    "unifi-protect://console",
    {
      title: "Console",
      description:
        "The NVR: model, Protect version, storage, and the TIME ZONE every local time in this " +
        "system is expressed in. Read this before interpreting a question about a wall-clock " +
        'hour such as "last night between 1am and 6am".',
      mimeType: "application/json",
    },
    async (uri) => {
      const nvr = await client.get<Rec>("nvr");
      const summary = summarizeNvr(nvr ?? {});
      return json(uri, {
        ...summary,
        timeZoneSource: config.timeZone ? "UNIFI_PROTECT_TIMEZONE override" : "console",
        timeZone: config.timeZone ?? summary.timezone,
      });
    },
  );

  server.registerResource(
    "cameras",
    "unifi-protect://cameras",
    {
      title: "Cameras and what they detect",
      description:
        "Every camera with the object types it will ACTUALLY detect, what its zones ask for, " +
        "and where the two disagree. A camera whose `blocked` list is non-empty cannot match a " +
        "search for those types no matter how the query is written.",
      mimeType: "application/json",
    },
    async (uri) => {
      const raw = await client.get<unknown>("cameras");
      const cameras = (Array.isArray(raw) ? raw : []).filter(isRecord).map(cameraFacts);
      return json(uri, {
        count: cameras.length,
        legend: {
          enabled: "smartDetectSettings.objectTypes — the gate; nothing outside this ever fires",
          zone: "what the detection zones ask for",
          blocked: "asked for by a zone but blocked by the device list — a silent misconfiguration",
        },
        cameras: cameras.map((c) => ({
          id: c.id,
          name: c.name,
          isConnected: c.isConnected,
          recordingMode: c.recordingMode,
          hasSmartDetect: c.hasSmartDetect,
          enabled: c.enabled,
          zone: c.zone,
          blocked: c.blocked,
          audioEnabled: c.audioEnabled,
        })),
      });
    },
  );

  server.registerResource(
    "locations",
    "unifi-protect://locations",
    {
      title: "Camera locations",
      description:
        "Named groups of cameras, so a question about a PLACE can be turned into camera ids. " +
        "The console has no concept of location, so this is local knowledge from " +
        "UNIFI_PROTECT_LOCATIONS. If it is empty, ask which cameras cover the area rather " +
        "than guessing from names.",
      mimeType: "application/json",
    },
    async (uri) =>
      json(uri, {
        configured: availableLocations(config.locations),
        locations: config.locations,
        ...(Object.keys(config.locations).length === 0
          ? {
              note:
                "No locations configured. Set UNIFI_PROTECT_LOCATIONS to a JSON object, e.g. " +
                '{"front":["Carillon","Portail"],"garden":["Jardin"]}. Camera names are matched ' +
                "case-insensitively. Without it, `location` cannot be used and cameras must be " +
                "named by id.",
            }
          : {}),
      }),
  );
};
