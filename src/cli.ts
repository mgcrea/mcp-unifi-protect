#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZodError } from "zod";

import { BUILD_INFO } from "./build-info.js";
import { isConfigured, loadConfig, setupInstructions } from "./config.js";
import { createServer } from "./server.js";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the JSON-RPC stream — usually failing the client's
// next parse, far from the cause.
// oxlint-disable no-console -- this is the process entry point; stderr is the log channel.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.UNIFI_PROTECT_DEBUG) console.error("[unifi-protect-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[unifi-protect-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[unifi-protect-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  const config = loadConfig();
  // Before anything can open a socket.

  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  stderrLogger.warn(
    `unifi-protect-mcp connected (mode=${config.mode}, ` +
      (config.mode === "cloud"
        ? `console=${config.consoleId ?? "MISSING"}, auth=${config.apiKey ? "api-key" : "MISSING"}, `
        : `host=${config.baseUrl ?? "MISSING"}, user=${config.username ?? "MISSING"}, `) +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
      `tls=${config.mode === "cloud" || config.verifyTls ? "verified" : "UNVERIFIED"})`,
  );

  // Connecting successfully but exposing one tool is confusing unless we say
  // why. The server no longer refuses to start over this, so the banner and
  // unifi_protect_auth_status are the only channels left.
  for (const issue of config.issues) stderrLogger.warn(`  ${issue}`);

  if (!isConfigured(config)) {
    stderrLogger.warn("  not configured — only unifi_protect_auth_status is available:");
    for (const line of setupInstructions(config)) stderrLogger.warn(`  ${line}`);
    stderrLogger.warn("  Call unifi_protect_auth_status for this same guidance in your client.");
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[unifi-protect-mcp] fatal: ${describeFatal(err)}`);
  if (process.env.UNIFI_PROTECT_DEBUG && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
