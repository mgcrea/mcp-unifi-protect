import { statSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProtectClient } from "#/client/protect";
import { isConfigured, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { confirmArg, wrap } from "#/tools/util";

const fileMode = (path: string): number | undefined => {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
};

export const registerStatusTools = (
  server: McpServer,
  client: ProtectClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_auth_status",
    {
      title: "UniFi Protect: Auth Status",
      description:
        "Check whether this server can actually reach your UniFi Protect console. By default it " +
        "logs in and makes a real call, so the answer reflects the console rather than cached " +
        "state — this is the tool to run when something is not working. Reports the host, the " +
        "account, the Protect version, whether TLS is verified, and whether writes are enabled; " +
        "when nothing is configured it returns the exact setup steps instead. Call this first " +
        "when a tool you expected is not listed: an absent tool means missing configuration or " +
        "writes being off, not a bug.",
      inputSchema: z.object({
        probe: z
          .boolean()
          .default(true)
          .describe(
            "Actually contact the console (logging in if needed) rather than only reporting " +
              "what is already cached. Set false for a fast, purely local answer.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ probe }) =>
      wrap(async () => {
        const configured = isConfigured(ctx.config);
        if (!configured) {
          return {
            configured: false,
            mode: ctx.config.mode,
            ...(ctx.config.issues.length > 0 ? { issues: ctx.config.issues } : {}),
            host: ctx.config.baseUrl ?? null,
            available_without_credentials: ["unifi_protect_auth_status"],
            setup: setupInstructions(ctx.config),
          };
        }

        // Reporting only the cached session state answers the wrong question: a
        // freshly started server has no session yet and would report
        // "authenticated: false" while being perfectly able to reach the
        // console. So by default this actually logs in and calls the API, and
        // reports what happened.
        let reachable: boolean | undefined;
        let version: unknown;
        let failure: string | undefined;
        if (probe) {
          try {
            const bootstrap = await client.get<Record<string, unknown>>("bootstrap");
            const nvr = bootstrap?.nvr;
            version =
              typeof nvr === "object" && nvr !== null
                ? (nvr as Record<string, unknown>).version
                : undefined;
            reachable = true;
          } catch (err) {
            reachable = false;
            failure = err instanceof Error ? err.message : String(err);
          }
        }

        const status = ctx.session.describe();
        const mode = fileMode(ctx.config.sessionFile);
        return {
          configured: true,
          mode: ctx.config.mode,
          // Incomplete or contradictory configuration. Never fatal — reported
          // here so it reaches the client, which never sees stderr.
          ...(ctx.config.issues.length > 0 ? { issues: ctx.config.issues } : {}),
          ...(ctx.config.modeSource === "invalid"
            ? { modeWarning: `UNIFI_PROTECT_MODE was not recognised; assumed ${ctx.config.mode}.` }
            : {}),
          ...(ctx.config.mode === "cloud"
            ? {
                via: "api.ui.com Site Manager connector",
                consoleId: ctx.config.consoleId,
              }
            : {}),
          host: ctx.config.baseUrl ?? null,
          username: status.username ?? null,
          ...(probe
            ? {
                reachable,
                ...(version !== undefined ? { protectVersion: version } : {}),
                ...(failure ? { failure } : {}),
              }
            : {}),
          session:
            ctx.config.mode === "cloud"
              ? {
                  // Cloud mode holds no session: the connector authenticates
                  // every request from the API key, so there is nothing cached
                  // and no file on disk.
                  authenticated: status.authenticated,
                  source: status.source,
                }
              : {
                  authenticated: status.authenticated,
                  // "restored" means it came from disk and has not been proven
                  // yet — the first real call is what confirms it, via a 401
                  // and re-login if the cookie has expired.
                  source: status.source,
                  established_at: status.savedAt ?? null,
                  file: ctx.config.sessionFile,
                  file_mode: mode === undefined ? "absent" : `0${mode.toString(8)}`,
                  ...(mode !== undefined && (mode & 0o077) !== 0
                    ? {
                        warning: `Readable by other users. Run: chmod 600 ${ctx.config.sessionFile}`,
                      }
                    : {}),
                },
          tls:
            ctx.config.mode === "cloud"
              ? "verified (api.ui.com presents a real certificate; the console's self-signed one is never seen)"
              : ctx.config.verifyTls
                ? "verified"
                : "UNVERIFIED — certificate checks are off for this server's requests only. " +
                  "Verifying needs both NODE_EXTRA_CA_CERTS pointing at the console certificate and " +
                  "UNIFI_PROTECT_HOST set to a host name: the certificate carries no IP SAN.",
          writes: ctx.allowWrites ? "enabled" : "disabled",
          api:
            "private (undocumented). Ubiquiti moves these endpoints between Protect releases, so " +
            "the Protect version reported above is the first thing to check if a tool that used " +
            "to work starts returning 404.",
        };
      }),
  );

  // The login tools are pointless without a console to log in to, so they do
  // not exist until one is configured — and they are meaningless in cloud mode,
  // where the connector authenticates every request from the API key and there
  // is no session to establish, cache or discard.
  if (!isConfigured(ctx.config) || ctx.config.mode === "cloud") return;

  server.registerTool(
    "unifi_protect_auth_login",
    {
      title: "UniFi Protect: Auth Login",
      description:
        "Force a fresh login to the console, replacing any cached session. Normally unnecessary " +
        "— the server logs in on demand and re-authenticates automatically on a 401. Use it to " +
        "supply a two-factor code, which cannot be done unattended: the code is single-use and " +
        "expires in about 30 seconds, so it is passed here once and the resulting session is " +
        "then cached and reused.",
      inputSchema: z.object({
        totp: z
          .string()
          .regex(/^\d{6,8}$/, "A two-factor code is 6 to 8 digits.")
          .optional()
          .describe("Current code from your authenticator app. Omit if the account has no 2FA."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ totp }) =>
      wrap(async () => {
        const status = await ctx.session.login(totp);
        return {
          authenticated: status.authenticated,
          username: status.username,
          established_at: status.savedAt,
          session_file: ctx.config.sessionFile,
          note: "The session is stored with mode 600 and reused until the console rejects it.",
        };
      }),
  );

  server.registerTool(
    "unifi_protect_auth_logout",
    {
      title: "UniFi Protect: Auth Logout",
      description:
        "Drop the cached session and delete the session file. The next call logs in again from " +
        "the configured username and password, so this does not lock anything out — use it to " +
        "clear a session after changing accounts, or to remove the cookie from disk.",
      inputSchema: z.object({ confirm: confirmArg }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        await ctx.session.logout();
        return {
          logged_out: true,
          note: "Credentials are unchanged; the next tool call will log in again.",
        };
      }),
  );
};
