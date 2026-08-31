#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { isConfigured, loadConfig, setupInstructions, type Config } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the JSON-RPC stream — usually failing the client's
// next parse, far from the cause.
// oxlint-disable no-console -- this is the process entry point; stderr is the log channel.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.UNIFI_PROTECT_DEBUG) console.error("[unifi-protect-mcp]", ...args);
  },
  // Not optional despite nothing here calling it: @mgcrea/unifi-protect reports
  // a newly learned certificate fingerprint at info, and that is the one line
  // someone needs in order to pin it explicitly afterwards. Omitting `info`
  // drops it silently, because the client's Logger has every level optional.
  info: (...args: unknown[]) => console.error("[unifi-protect-mcp]", ...args),
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

/**
 * How TLS will be handled, said once at startup.
 *
 * "pinned" is a promise about the first request rather than a report of one:
 * the certificate is read lazily, because nothing here may open a socket — a
 * console that is asleep has to surface as a failed tool call, not as a server
 * that never starts.
 */
const tlsBanner = (config: Config): string => {
  if (config.mode === "cloud") return "verified";
  if (!config.verifyTls) return "UNVERIFIED";
  return config.fingerprint ? "pinned (fingerprint configured)" : "pinned on first use";
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  const config = loadConfig();

  const { server, close } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  stderrLogger.warn(
    `unifi-protect-mcp connected (mode=${config.mode}, ` +
      (config.mode === "cloud"
        ? `console=${config.consoleId ?? "MISSING"}, auth=${config.apiKey ? "api-key" : "MISSING"}, `
        : `host=${config.baseUrl ?? "MISSING"}, user=${config.username ?? "MISSING"}, `) +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
      `tls=${tlsBanner(config)})`,
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
    // Releases the dispatcher's keep-alive sockets. Best-effort: the exit below
    // is what actually ends the process, and a hung close must not delay it.
    void close().catch(() => undefined);
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
