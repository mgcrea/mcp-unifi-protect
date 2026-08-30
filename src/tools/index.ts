import type { McpServer } from "@modelcontextprotocol/server";

import type { SessionProvider } from "#/client/auth";
import type { DeviceCache } from "#/client/device-cache";
import type { ProtectClient } from "#/client/protect";
import { isConfigured, type Config } from "#/config";
import { registerAuditTools } from "#/tools/audit";
import { registerCameraTools } from "#/tools/cameras";
import { registerDeviceTools } from "#/tools/devices";
import { registerEventTools } from "#/tools/events";
import { registerRequestTool } from "#/tools/request";
import { registerStatusTools } from "#/tools/status";
import { registerSystemTools } from "#/tools/system";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see UNIFI_PROTECT_ALLOW_WRITES. */
  allowWrites: boolean;
  session: SessionProvider;
  devices: DeviceCache;
};

/**
 * Register the UniFi Protect tools.
 *
 * unifi_protect_auth_status comes first and unconditionally, so a server with no
 * console configured is still a useful one — it can say what to set — rather
 * than a connection that closes with its own error message swallowed.
 *
 * Read tools are then always registered; the write tools only when
 * `allowWrites` is set, so with the flag off they are not merely refused — they
 * are absent from tools/list and cannot be called at all. A refusal still lets a
 * model try, retry, and reason about how to get around it; a tool that does not
 * exist ends the conversation.
 */
export const registerTools = (server: McpServer, client: ProtectClient, ctx: ToolContext): void => {
  registerStatusTools(server, client, ctx);
  if (!isConfigured(ctx.config)) return;

  registerSystemTools(server, client, ctx);
  registerAuditTools(server, client, ctx);
  registerCameraTools(server, client, ctx);
  registerEventTools(server, client, ctx);
  registerDeviceTools(server, client, ctx);
  registerRequestTool(server, client, ctx.allowWrites);
};
