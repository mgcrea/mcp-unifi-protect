import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { staticSessionProvider } from "../src/client/auth.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const baseConfig: Config = {
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
  "unifi_protect_get_event_thumbnail",
  "unifi_protect_get_system_info",
  "unifi_protect_list_cameras",
  "unifi_protect_list_chimes",
  "unifi_protect_list_events",
  "unifi_protect_list_lights",
  "unifi_protect_list_liveviews",
  "unifi_protect_list_sensors",
  "unifi_protect_list_users",
  "unifi_protect_list_viewers",
  "unifi_protect_request",
];

const WRITE_TOOLS = [
  "unifi_protect_ptz_goto_preset",
  "unifi_protect_ptz_start_patrol",
  "unifi_protect_ptz_stop_patrol",
  "unifi_protect_reboot_camera",
  "unifi_protect_reboot_nvr",
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
