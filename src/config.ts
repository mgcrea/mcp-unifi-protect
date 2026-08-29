import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

/**
 * The private (undocumented) Protect API, mounted under UniFi OS's proxy. This
 * server deliberately wraps this rather than the official Integration API at
 * `/proxy/protect/integration/v1`: the official one has NO historical query
 * capability at all — its only query parameters in the entire published OpenAPI
 * spec are `channel`, `highQuality` and `qualities` — so "what happened at the
 * front door last night" is unanswerable through it.
 *
 * The trade is real and accepted: nothing below is contractual, and Ubiquiti
 * moves these endpoints between Protect releases. `unifi_protect_get_system_info`
 * reports the running version so a mismatch is visible, and
 * `unifi_protect_request` reaches anything that moved without a code change.
 */
export const PRIVATE_API_PATH = "/proxy/protect/api";

/** UniFi OS's own auth surface, which is NOT under the Protect proxy path. */
export const LOGIN_PATH = "/api/auth/login";

/** The realtime channel. Not used yet — see the WebSocket note in the README. */
export const UPDATES_WS_PATH = "/proxy/protect/ws/updates";

const ConfigSchema = z
  .object({
    /** Console origin, e.g. `https://192.168.1.1` or `https://10.0.0.1:8443`. */
    baseUrl: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /**
     * A 2FA code is single-use and expires in ~30s, so it is only ever useful
     * for a one-shot `unifi_protect_auth_login`, never for an unattended start.
     */
    totp: z.string().min(1).optional(),
    /**
     * Consoles ship a self-signed certificate reached by IP, so neither chain
     * trust nor hostname verification can succeed. Defaults to false for that
     * reason; set true only if you installed a real certificate on the console.
     */
    verifyTls: z.boolean().default(false),
    allowWrites: z.boolean().default(false),
    sessionFile: z.string().min(1),
    snapshotDir: z.string().min(1),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    /** Guards against an unexpectedly huge video export blowing up the process. */
    maxDownloadBytes: z.number().int().positive().default(200_000_000),
    /** How long a cached camera id→name index stays fresh, in seconds. */
    deviceCacheTtlSeconds: z.number().int().nonnegative().max(3600).default(60),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Deliberately NOT an error when nothing is configured. An MCP server that
    // exits at startup shows up in the client as a bare "MCP error -32000:
    // Connection closed" with stderr swallowed — so the one message that would
    // have explained what to set never reaches anyone. The server stays up,
    // registers unifi_protect_auth_status, and reports the gap as data.
    //
    // A half-configured install IS worth flagging, though: a host with no
    // password is a typo, not a deliberate state, and saying so beats letting
    // every call fail with an auth error that reads like a wrong password.
    if (cfg.baseUrl && !cfg.username) {
      ctx.addIssue({
        code: "custom",
        path: ["username"],
        message:
          "UNIFI_PROTECT_HOST is set but UNIFI_PROTECT_USERNAME is not. Both, plus " +
          "UNIFI_PROTECT_PASSWORD, are needed to reach the console.",
      });
    }
    if (cfg.username && !cfg.password) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "UNIFI_PROTECT_USERNAME is set but UNIFI_PROTECT_PASSWORD is not.",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather
 * than the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `userName` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    host: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    verifyTls: z.boolean().optional(),
    allowWrites: z.boolean().optional(),
    sessionFile: z.string().min(1).optional(),
    snapshotDir: z.string().min(1).optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    maxDownloadBytes: z.number().int().positive().optional(),
    deviceCacheTtlSeconds: z.number().int().nonnegative().max(3600).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

/**
 * Normalize whatever someone pasted into a console origin, preserving the port.
 *
 *   "192.168.1.1"              -> "https://192.168.1.1"
 *   "10.0.0.1:8443"            -> "https://10.0.0.1:8443"
 *   "https://udm.lan/protect/" -> "https://udm.lan"
 *
 * A port must survive: consoles are commonly reached on a non-443 port, and the
 * normalizers in mcp-keycloak and mcp-shopify both drop it. Everything after
 * the origin is discarded — the API paths are this server's business, and a
 * pasted `/protect/dashboard` URL would otherwise be prefixed onto every call.
 *
 * `https` is forced: UniFi OS redirects plain HTTP, and following that redirect
 * would send the session cookie over cleartext on the first hop.
 */
export const normalizeBaseUrl = (raw: string): string => {
  const trimmedRaw = raw.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmedRaw) ? trimmedRaw : `https://${trimmedRaw}`;
  const url = new URL(withScheme);
  // `url.host` rather than `hostname` so an explicit :port is kept.
  return `https://${url.host}`;
};

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where the config file lives, most specific first: an explicit override, then
 * the XDG location, then the conventional `~/.config`.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.UNIFI_PROTECT_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "unifi-protect", "config.json");
};

/** The session file sits beside the config file unless told otherwise. */
export const resolveSessionPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(dirname(resolveConfigPath(env)), "session.json");

/**
 * The session file holds a live console cookie, so being readable by other
 * users is worth saying out loud. A warning and not an error: refusing to start
 * would be a worse trade for someone on a single-user machine.
 */
export const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(
        `[unifi-protect] ${path} is readable by other users. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // Not worth failing startup over.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every other
 * failure throws and names the path, so a malformed file is never mistaken for
 * a missing one — that confusion sends you hunting for credentials that were
 * sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field** — not whole-source.
 * Docker and CI inject the environment and must keep working untouched, while a
 * one-off `UNIFI_PROTECT_ALLOW_WRITES=0` still has to override a file that says
 * `true`. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const host = trimmed(env.UNIFI_PROTECT_HOST) ?? file.host;
  const sessionFile =
    trimmed(env.UNIFI_PROTECT_SESSION_FILE) ?? file.sessionFile ?? resolveSessionPath(env);
  const snapshotDir =
    trimmed(env.UNIFI_PROTECT_SNAPSHOT_DIR) ??
    file.snapshotDir ??
    join(homedir(), ".cache", "unifi-protect");

  return ConfigSchema.parse({
    baseUrl: host ? normalizeBaseUrl(host) : undefined,
    username: trimmed(env.UNIFI_PROTECT_USERNAME) ?? file.username,
    password: trimmed(env.UNIFI_PROTECT_PASSWORD) ?? file.password,
    totp: trimmed(env.UNIFI_PROTECT_TOTP),
    verifyTls: parseBool(env.UNIFI_PROTECT_VERIFY_TLS) ?? file.verifyTls,
    allowWrites: parseBool(env.UNIFI_PROTECT_ALLOW_WRITES) ?? file.allowWrites,
    sessionFile: expandTilde(sessionFile),
    snapshotDir: expandTilde(snapshotDir),
    maxRetries: parseIntOpt(env.UNIFI_PROTECT_MAX_RETRIES) ?? file.maxRetries,
    maxDownloadBytes: parseIntOpt(env.UNIFI_PROTECT_MAX_DOWNLOAD_BYTES) ?? file.maxDownloadBytes,
    deviceCacheTtlSeconds:
      parseIntOpt(env.UNIFI_PROTECT_DEVICE_CACHE_TTL) ?? file.deviceCacheTtlSeconds,
  });
};

/** True once the server has everything it needs to reach a console. */
export const isConfigured = (config: Config): boolean =>
  Boolean(config.baseUrl && config.username && config.password);

/**
 * Returned by unifi_protect_auth_status and printed to stderr at startup. Prose
 * rather than a code, because this is the text someone acts on when nothing
 * works — and the server can no longer signal it by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => {
  if (isConfigured(config)) return [];
  return [
    "No UniFi Protect console is configured, so only unifi_protect_auth_status is registered.",
    "Set UNIFI_PROTECT_HOST to your console's address — the IP or hostname of the UDM Pro, " +
      "UNVR or Cloud Key, e.g. 192.168.1.1 (https:// is assumed, and a :port is preserved).",
    "Set UNIFI_PROTECT_USERNAME and UNIFI_PROTECT_PASSWORD to a console login.",
    // The advice that actually matters. A Ubiquiti SSO account often cannot log
    // in locally at all, and reusing the owner account hands an agent the keys
    // to the whole console rather than to Protect.
    "Create a dedicated LOCAL user for this rather than reusing your own: UniFi OS → Settings → " +
      "Admins & Users → Add User → Local Access Only, and give it Protect permissions only. A " +
      "Ubiquiti cloud (SSO) account may fail local login entirely, and a local account keeps the " +
      "blast radius to Protect.",
    "Give that user View-Only rights unless you intend to set UNIFI_PROTECT_ALLOW_WRITES=1 — " +
      "with writes off the mutating tools are not registered at all, so they cannot be called.",
    "If the account has 2FA, pass a current code once via unifi_protect_auth_login; the session " +
      "is then cached and reused. A code in UNIFI_PROTECT_TOTP expires in about 30 seconds, so " +
      "it is no use for an unattended start.",
    "Consoles use a self-signed certificate, so UNIFI_PROTECT_VERIFY_TLS defaults to false. " +
      "Set it to true only if you installed a certificate your machine already trusts.",
  ];
};
