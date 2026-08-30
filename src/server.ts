import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "./build-info.js";
import { createSessionProvider, type Logger, type SessionProvider } from "./client/auth.js";
import { createDeviceCache, type DeviceCache } from "./client/device-cache.js";
import { ProtectClient } from "./client/protect.js";
import { createHttpFetch } from "./client/tls.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-unifi-protect-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the session provider (tests, and the interactive login flow). */
  session?: SessionProvider;
};

export type CreatedServer = {
  server: McpServer;
  client: ProtectClient;
  session: SessionProvider;
  devices: DeviceCache;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Built once and shared by the session provider and the client, so the TLS
  // policy is a property of this server's requests rather than of the process.
  // Tests inject `opts.fetch` and never reach createHttpFetch.
  const fetchImpl =
    opts.fetch ??
    createHttpFetch({
      insecureTls: !config.verifyTls,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const session =
    opts.session ??
    createSessionProvider({
      config,
      fetch: fetchImpl,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const client = new ProtectClient({
    // An unconfigured server still constructs a client, so createServer stays
    // total. No tool that could use it is registered, and the session provider
    // throws a message naming the fix if something ever reaches it anyway.
    baseUrl: config.baseUrl ?? "https://unconfigured.invalid",
    session,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    maxDownloadBytes: config.maxDownloadBytes,
    fetch: fetchImpl,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const devices = createDeviceCache({ client, ttlSeconds: config.deviceCacheTtlSeconds });

  registerTools(server, client, {
    config,
    allowWrites: config.allowWrites,
    session,
    devices,
  });

  return { server, client, session, devices };
};
