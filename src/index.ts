export {
  createServer,
  SERVER_NAME,
  SERVER_VERSION,
  USER_AGENT,
  type CreatedServer,
  type CreateServerOptions,
} from "#/server";
export {
  expandTilde,
  isConfigured,
  loadConfig,
  LOGIN_PATH,
  normalizeBaseUrl,
  PRIVATE_API_PATH,
  resolveConfigPath,
  resolveSessionPath,
  resolveTrustPath,
  setupInstructions,
  UPDATES_WS_PATH,
  type Config,
  type FileConfig,
} from "#/config";
/**
 * The console client is `@mgcrea/unifi-protect` and is re-exported so a
 * consumer of this server does not have to depend on both. What used to be
 * exported from here — `createSessionProvider` taking this server's `Config`,
 * and the `loadSession`/`saveSession` helpers — is gone: the handshake now
 * lives in that package, whose `createSessionProvider` takes a base URL and
 * credentials instead. Hence the major version.
 */
export {
  buildQuery,
  ProtectClient,
  staticSessionProvider,
  type BinaryResult,
  type Logger,
  type ProtectClientOptions,
  type Query,
  type SessionHeaders,
  type SessionProvider,
  type SessionStatus,
} from "@mgcrea/unifi-protect";
export {
  apiKeySessionProvider,
  createConsoleSessionProvider,
  notConfiguredSessionProvider,
} from "#/client/session";
export { createLazyTransport, type LazyTransport } from "#/client/transport";
export { createDeviceCache, type DeviceCache } from "#/client/device-cache";
export {
  NotConfiguredError,
  ProtectApiError,
  ProtectAuthError,
  ProtectTlsError,
  WritesDisabledError,
} from "#/client/errors";
export {
  buildNameIndex,
  isoTime,
  summarizeBootstrap,
  summarizeCamera,
  summarizeChime,
  summarizeEach,
  summarizeEvent,
  summarizeLight,
  summarizeLiveview,
  summarizeNvr,
  summarizeSensor,
  summarizeUser,
  summarizeViewer,
  type NameIndex,
} from "#/client/shape";
export { registerTools, type ToolContext } from "#/tools/index";
export { assertSafePath } from "#/tools/request";
export { toEpochMs } from "#/tools/util";
