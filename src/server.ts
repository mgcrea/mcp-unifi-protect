import { ProtectClient, type Logger, type SessionProvider } from "@mgcrea/unifi-protect";
import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import { createDeviceCache, type DeviceCache } from "#/client/device-cache";
import { apiKeySessionProvider, createConsoleSessionProvider } from "#/client/session";
import { createLazyTransport, type LazyTransport } from "#/client/transport";
import { consoleOrigin, isConfigured, type Config } from "#/config";
import { registerPrompts } from "#/prompts";
import { registerResources } from "#/resources";
import { registerTools } from "#/tools/index";

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
  /** Releases the transport's keep-alive sockets, which hold the event loop open. */
  close: () => Promise<void>;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Built once and shared by the session provider and the client, so the TLS
  // policy is a property of this server's requests rather than of the process.
  // It resolves lazily on the first request — see the note in transport.ts:
  // nothing here may open a socket, or an unreachable console becomes a server
  // that never starts. Tests inject `opts.fetch` and never build one.
  let transport: LazyTransport | undefined;
  let fetchImpl: typeof fetch;
  if (opts.fetch) {
    fetchImpl = opts.fetch;
  } else {
    transport = createLazyTransport({ config, ...(opts.logger ? { logger: opts.logger } : {}) });
    fetchImpl = transport.fetch;
  }

  // Cloud mode needs no login: the Site Manager connector authenticates each
  // request from the API key, so the whole cookie/CSRF handshake is skipped.
  const session =
    opts.session ??
    (config.mode === "cloud" && config.apiKey
      ? apiKeySessionProvider(config.apiKey)
      : createConsoleSessionProvider({
          config,
          fetch: fetchImpl,
          ...(opts.logger ? { logger: opts.logger } : {}),
        }));

  const client = new ProtectClient({
    // An unconfigured server still constructs a client, so createServer stays
    // total. No tool that could use it is registered, and the session provider
    // throws a message naming the fix if something ever reaches it anyway.
    baseUrl: consoleOrigin(config) ?? "https://unconfigured.invalid",
    session,
    maxRetries: config.maxRetries,
    userAgent: USER_AGENT,
    maxDownloadBytes: config.maxDownloadBytes,
    downloadLimitHint: "Narrow the request, or raise UNIFI_PROTECT_MAX_DOWNLOAD_BYTES.",
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

  // Gated the same way the read tools are: an unconfigured server advertising
  // resources it cannot read would fail on every fetch, which is worse than not
  // offering them. Prompts follow, since both of them drive those tools.
  if (isConfigured(config)) {
    registerResources(server, client, config);
    registerPrompts(server);
  }

  return {
    server,
    client,
    session,
    devices,
    close: async () => await transport?.close(),
  };
};
