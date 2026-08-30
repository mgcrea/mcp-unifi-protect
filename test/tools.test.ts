import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { staticSessionProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { calledInit, calledUrl, fetchMock } from "./helpers.js";

/** A camera whose zone asks for person while the device list blocks it. */
const GATED_CAMERA = {
  id: "cam1",
  name: "Carillon",
  isConnected: true,
  featureFlags: { hasSmartDetect: true, smartDetectTypes: ["person", "animal"] },
  smartDetectSettings: { objectTypes: ["animal"] },
  smartDetectZones: [{ id: 1, objectTypes: ["person", "animal"] }],
  recordingSettings: { mode: "always" },
};

const baseConfig: Config = {
  mode: "local",
  modeSource: "default",
  issues: [],
  baseUrl: "https://192.168.1.1",
  username: "mcp",
  password: "secret",
  verifyTls: false,
  allowWrites: false,
  sessionFile: "/tmp/unifi-protect-test-session.json",
  snapshotDir: "/tmp/unifi-protect-test-snapshots",
  maxRetries: 3,
  maxDownloadBytes: 200_000_000,
  deviceCacheTtlSeconds: 60,
  locations: {},
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({ config, fetch: fetchImpl, session: staticSessionProvider() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).toSorted();

const enumOf = async (
  client: Client,
  tool: string,
  prop: string,
): Promise<string[] | undefined> => {
  const found = (await client.listTools()).tools.find((t) => t.name === tool);
  if (!found) throw new Error(`tool ${tool} is not registered`);
  const properties = found.inputSchema.properties as Record<string, { enum?: string[] }>;
  return properties[prop]?.enum;
};

const READ_TOOLS = [
  "unifi_protect_auth_login",
  "unifi_protect_auth_logout",
  "unifi_protect_auth_status",
  "unifi_protect_export_video",
  "unifi_protect_get_camera",
  "unifi_protect_get_camera_snapshot",
  "unifi_protect_get_event",
  "unifi_protect_check_settings",
  "unifi_protect_get_event_thumbnail",
  "unifi_protect_get_event_thumbnails",
  "unifi_protect_get_system_info",
  "unifi_protect_list_cameras",
  "unifi_protect_list_chimes",
  "unifi_protect_list_events",
  "unifi_protect_list_lights",
  "unifi_protect_list_liveviews",
  "unifi_protect_list_ptz_patrols",
  "unifi_protect_list_ptz_presets",
  "unifi_protect_list_sensors",
  "unifi_protect_list_users",
  "unifi_protect_list_viewers",
  "unifi_protect_request",
];

const WRITE_TOOLS = [
  "unifi_protect_reboot_camera",
  "unifi_protect_reboot_nvr",
  "unifi_protect_set_camera_detections",
  "unifi_protect_set_camera_recording_mode",
  "unifi_protect_update_camera",
  "unifi_protect_update_chime",
  "unifi_protect_update_light",
  "unifi_protect_update_nvr_settings",
  "unifi_protect_update_sensor",
  "unifi_protect_update_viewer",
];

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(baseConfig));
    withWrites = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
  });

  // toEqual rather than toContain, so adding a tool is always a deliberate act
  // with a visible diff rather than something that slips in unnoticed.
  it("registers exactly the read tools when writes are disabled", () => {
    expect(readOnly).toEqual([...READ_TOOLS].toSorted());
  });

  it("registers the reads plus the writes when writes are enabled", () => {
    expect(withWrites).toEqual([...READ_TOOLS, ...WRITE_TOOLS].toSorted());
  });

  it("does not merely refuse write tools when writes are off — they are absent", () => {
    for (const name of WRITE_TOOLS) {
      expect(readOnly, name).not.toContain(name);
    }
  });

  it("registers only auth_status when nothing is configured", async () => {
    // The state a first-time user lands in. The server must still connect and
    // answer tools/list: exiting here shows in the client as a bare
    // "Connection closed" with stderr swallowed.
    const unconfigured = await connect({
      ...baseConfig,
      baseUrl: undefined,
      username: undefined,
      password: undefined,
    });
    expect(await toolNames(unconfigured)).toEqual(["unifi_protect_auth_status"]);
  });

  it("returns setup instructions rather than an error when unconfigured", async () => {
    const client = await connect({
      ...baseConfig,
      baseUrl: undefined,
      username: undefined,
      password: undefined,
    });
    const result = await client.callTool({ name: "unifi_protect_auth_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      configured: boolean;
      setup: string[];
    };
    expect(payload.configured).toBe(false);
    expect(payload.setup.join(" ")).toContain("UNIFI_PROTECT_HOST");
  });

  it("update_camera sends only the fields passed, in the console's own schema", async () => {
    // Verified against a live console on 7.2.105: a camera has NO top-level
    // `ledLevel` (that is a floodlight field) and its ledSettings block is
    // {isEnabled, welcomeLed, floodLed} — an earlier version sent a
    // fabricated `isLedForced`. The console deep-merges, so sending one key
    // inside osdSettings preserves its siblings.
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "cam1", name: "Cuisine" }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    await client.callTool({
      name: "unifi_protect_update_camera",
      arguments: { cameraId: "cam1", osdDate: true, statusLedEnabled: true },
    });
    const init = calledInit<{ body: string }>(fetchImpl);
    expect(JSON.parse(init.body)).toEqual({
      osdSettings: { isDateEnabled: true },
      ledSettings: { isEnabled: true },
    });
  });

  it("update_camera refuses an empty patch instead of sending one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "unifi_protect_update_camera",
      arguments: { cameraId: "cam1" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("auth_status probes the console rather than reporting stale cached state", async () => {
    // A freshly started server holds no session yet. Reporting only that would
    // say "authenticated: false" about a server that can reach the console
    // perfectly well — the wrong answer to the question this tool exists for.
    const fetchImpl = vi.fn(async () => jsonResponse({ nvr: { version: "6.2.83" } }));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({ name: "unifi_protect_auth_status", arguments: {} });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      reachable: boolean;
      protectVersion: string;
    };
    expect(payload.reachable).toBe(true);
    expect(payload.protectVersion).toBe("6.2.83");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("auth_status reports an unreachable console as data, not as a tool error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 403));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({ name: "unifi_protect_auth_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      reachable: boolean;
      failure: string;
    };
    expect(payload.reachable).toBe(false);
    expect(payload.failure).toMatch(/403/);
  });

  it("auth_status skips the network when probe is false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    await client.callTool({ name: "unifi_protect_auth_status", arguments: { probe: false } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("annotates reads readOnly and irreversible writes destructive", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    expect(byName.get("unifi_protect_list_cameras")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("unifi_protect_list_events")?.annotations?.readOnlyHint).toBe(true);
    // Reboots lose footage and cannot be undone.
    expect(byName.get("unifi_protect_reboot_nvr")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("unifi_protect_reboot_camera")?.annotations?.destructiveHint).toBe(true);
    // Settings changes are writes but not destructive.
    expect(byName.get("unifi_protect_update_camera")?.annotations?.destructiveHint).toBe(false);
  });

  it("every tool carries annotations", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean");
    }
  });
});

describe("cloud mode", () => {
  const cloudConfig: Config = {
    ...baseConfig,
    mode: "cloud",
    modeSource: "explicit",
    baseUrl: undefined,
    username: undefined,
    password: undefined,
    consoleId: "ABC123:456",
    apiKey: "sekret-key",
  };

  it("addresses the console through the Site Manager connector, with the api key", async () => {
    // The connector forwards the PRIVATE api, not only the official Integration
    // API — verified against a live console. So the paths are identical to
    // local mode and only the origin and the auth header differ.
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const { server, client } = createServer({
      config: cloudConfig,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    void server;
    await client.get("cameras");

    expect(calledUrl(fetchImpl)).toBe(
      "https://api.ui.com/v1/connector/consoles/ABC123:456/proxy/protect/api/cameras",
    );
    const init = calledInit<{ headers: Record<string, string> }>(fetchImpl);
    expect(init.headers["x-api-key"]).toBe("sekret-key");
    // No login happened: there is no cookie and no CSRF token to send.
    expect(init.headers.cookie).toBeUndefined();
    expect(init.headers["x-csrf-token"]).toBeUndefined();
  });

  it("never logs in, so a 401 is not retried into a re-auth loop", async () => {
    // A 401 from the connector means a wrong key or a console outside the
    // key's org. Re-authenticating cannot fix either, and retrying would just
    // multiply the failure.
    const fetchImpl = fetchMock(async () => jsonResponse({ error: "unauthorized" }, 401));
    const { client } = createServer({
      config: { ...cloudConfig, maxRetries: 2 },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.get("cameras")).rejects.toThrow();
    // Only the transport's own retries; no extra login round-trips.
    for (let i = 0; i < fetchImpl.mock.calls.length; i += 1) {
      expect(calledUrl(fetchImpl, i)).toContain("/proxy/protect/api/");
    }
  });

  it("registers the same tools as local mode, minus the login pair", async () => {
    // Identical surface everywhere it matters — but auth_login and auth_logout
    // would be lies here: there is no session to establish or discard.
    const names = await toolNames(await connect(cloudConfig));
    const expected = READ_TOOLS.filter(
      (n) => n !== "unifi_protect_auth_login" && n !== "unifi_protect_auth_logout",
    ).toSorted();
    expect(names).toEqual(expected);
  });
});

describe("unifi_protect_request", () => {
  it("only offers GET when writes are disabled", async () => {
    const client = await connect(baseConfig);
    expect(await enumOf(client, "unifi_protect_request", "method")).toEqual(["GET"]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "unifi_protect_request");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("offers the write methods when writes are enabled", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    expect(await enumOf(client, "unifi_protect_request", "method")).toEqual([
      "GET",
      "POST",
      "PATCH",
      "DELETE",
    ]);
  });

  it("refuses an absolute URL, so the session cannot be sent off-host", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "unifi_protect_request",
      arguments: { path: "https://evil.example.com/steal" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses path traversal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);
    const result = await client.callTool({
      name: "unifi_protect_request",
      arguments: { path: "cameras/../../../api/auth/login" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm, without reaching the console", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({ name: "unifi_protect_reboot_nvr", arguments: {} });

    expect(result.isError).toBe(true);
    // Crucially: the console was never touched. The schema rejected it first.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("list_events", () => {
  const routed = (events: unknown[] = []) =>
    fetchMock(async (url) => {
      const href = String(url);
      if (href.includes("/cameras")) return jsonResponse([GATED_CAMERA]);
      if (href.includes("/nvr")) return jsonResponse({ timezone: "Europe/Paris" });
      return jsonResponse(events);
    });

  const callEvents = async (
    args: Record<string, unknown>,
    impl = routed(),
  ): Promise<{ payload: Record<string, unknown>; impl: ReturnType<typeof routed> }> => {
    const client = await connect(baseConfig, impl as unknown as typeof fetch);
    const result = await client.callTool({ name: "unifi_protect_list_events", arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    return { payload: JSON.parse(text) as Record<string, unknown>, impl };
  };

  it("filters by camera ON THE CONSOLE rather than after the fact", async () => {
    // Filtering client-side fetched the newest `limit` events across ALL
    // cameras and discarded most, so a quiet camera over a long window came
    // back empty while reporting a successful search.
    const { impl } = await callEvents({ cameraId: "cam1", start: "7d" });
    const eventsCall = impl.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/events"));
    expect(eventsCall).toContain("cameras=cam1");
  });

  it("repeats the cameras parameter for several ids", async () => {
    // A comma-separated list is accepted by the console and silently matches
    // nothing, so the repeated form is the only correct one.
    const { impl } = await callEvents({ cameraIds: ["cam1", "cam2"], start: "7d" });
    const eventsCall = impl.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/events"))!;
    expect(eventsCall).toContain("cameras=cam1");
    expect(eventsCall).toContain("cameras=cam2");
    expect(eventsCall).not.toContain("cameras=cam1%2Ccam2");
  });

  it("warns that zero results mean the detector was off, not that nothing happened", async () => {
    const { payload } = await callEvents({
      cameraId: "cam1",
      smartDetectTypes: ["person"],
      start: "1am",
      end: "6am",
    });
    expect(payload.count).toBe(0);
    const warnings = (payload.warnings as string[]) ?? [];
    expect(warnings.join(" ")).toContain("detector was OFF");
  });

  it("interprets local times in the console's own zone", async () => {
    const { payload } = await callEvents({ start: "1am", end: "6am" });
    const window = payload.window as Record<string, string>;
    expect(window.timeZone).toBe("Europe/Paris");
    expect(window.localStart).toContain("01:00:00");
    expect(window.localEnd).toContain("06:00:00");
  });

  it("resolves a configured location to camera ids", async () => {
    const client = await connect(
      { ...baseConfig, locations: { front: ["Carillon"] } },
      routed() as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "unifi_protect_list_events",
      arguments: { location: "front", start: "7d" },
    });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      cameras?: string[];
    };
    expect(payload.cameras).toEqual(["Carillon"]);
  });

  it("names the configured locations when given an unknown one", async () => {
    const client = await connect(
      { ...baseConfig, locations: { front: ["Carillon"] } },
      routed() as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "unifi_protect_list_events",
      arguments: { location: "back", start: "7d" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("set_camera_detections", () => {
  const routed = () =>
    fetchMock(async (url, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      if (method === "PATCH") {
        return jsonResponse({
          ...GATED_CAMERA,
          smartDetectSettings: { objectTypes: ["person", "animal"], audioTypes: ["alrmSpeak"] },
          smartDetectZones: [{ id: 1, objectTypes: ["person", "animal"] }],
        });
      }
      return jsonResponse({
        ...GATED_CAMERA,
        featureFlags: {
          ...GATED_CAMERA.featureFlags,
          smartDetectAudioTypes: ["alrmSmoke", "alrmSpeak"],
        },
        smartDetectSettings: {
          objectTypes: ["animal"],
          audioTypes: ["alrmSmoke", "smoke_cmonx"],
        },
      });
    });

  it("drops values the console reports but refuses on write", async () => {
    // smoke_cmonx comes out of every read and fails every PATCH with
    // "The smart detection feature is not enabled for: smoke_cmonx".
    const impl = routed();
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      impl as unknown as typeof fetch,
    );
    await client.callTool({
      name: "unifi_protect_set_camera_detections",
      arguments: { cameraId: "cam1", audioTypes: ["alrmSpeak", "smoke_cmonx"] },
    });
    const patch = impl.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "PATCH",
    );
    const body = JSON.parse((patch![1] as { body: string }).body) as {
      smartDetectSettings: { audioTypes: string[] };
    };
    expect(body.smartDetectSettings.audioTypes).toEqual(["alrmSpeak"]);
  });

  it("brings the zones into line so none asks for a blocked type", async () => {
    const impl = routed();
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      impl as unknown as typeof fetch,
    );
    await client.callTool({
      name: "unifi_protect_set_camera_detections",
      arguments: { cameraId: "cam1", objectTypes: ["person", "animal"] },
    });
    const patch = impl.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "PATCH",
    );
    const body = JSON.parse((patch![1] as { body: string }).body) as {
      smartDetectZones: { objectTypes: string[] }[];
    };
    expect(body.smartDetectZones[0]!.objectTypes).toEqual(["person", "animal"]);
  });

  it("rejects a type the camera cannot do, naming what it supports", async () => {
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      routed() as unknown as typeof fetch,
    );
    const result = await client.callTool({
      name: "unifi_protect_set_camera_detections",
      arguments: { cameraId: "cam1", objectTypes: ["vehicle"] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("does not support");
  });
});

describe("resources and prompts", () => {
  it("exposes the console, cameras and locations resources", async () => {
    const client = await connect(baseConfig);
    const uris = (await client.listResources()).resources.map((r) => r.uri).toSorted();
    expect(uris).toEqual([
      "unifi-protect://cameras",
      "unifi-protect://console",
      "unifi-protect://locations",
    ]);
  });

  it("exposes the two workflow prompts", async () => {
    const client = await connect(baseConfig);
    const names = (await client.listPrompts()).prompts.map((p) => p.name).toSorted();
    expect(names).toEqual(["check_camera_settings", "who_passed"]);
  });

  it("registers no resources or prompts when nothing is configured", async () => {
    // They would fail on every read, which is worse than not offering them.
    const client = await connect({
      ...baseConfig,
      baseUrl: undefined,
      username: undefined,
      password: undefined,
    });
    await expect(client.listResources()).rejects.toThrow();
  });

  it("tells who_passed to check the warnings before answering", async () => {
    const client = await connect(baseConfig);
    const prompt = await client.getPrompt({
      name: "who_passed",
      arguments: { start: "1am", end: "6am" },
    });
    const body = prompt.messages.map((m) => (m.content as { text: string }).text).join(" ");
    expect(body).toContain("warnings");
    expect(body).toContain("thumbnails");
  });
});
