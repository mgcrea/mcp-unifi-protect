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

/**
 * How this server reaches the console.
 *
 * `local` talks to the console on your LAN and authenticates the way the
 * Protect web app does: a UniFi OS login yielding a session cookie and a CSRF
 * token.
 *
 * `cloud` goes through Ubiquiti's Site Manager connector at api.ui.com, which
 * forwards to the same console and authenticates with nothing but an API key.
 *
 * The connector proxies the PRIVATE Protect API, not merely the official
 * Integration API — verified against a live console: bootstrap, event search,
 * camera list and binary snapshots all answer 200 through it. That is what
 * makes cloud mode a genuine alternative rather than a reduced one; the
 * official Integration API on its own cannot answer any question about the
 * past, so it could never have replaced a local login.
 */
export const MODES = ["local", "cloud"] as const;
export type Mode = (typeof MODES)[number];

const CLOUD_BASE = "https://api.ui.com/v1/connector/consoles";

/**
 * What people actually type. Rejecting a reasonable synonym is a self-inflicted
 * support question, and these are the words the other UniFi servers accept.
 */
const MODE_ALIASES: Record<string, Mode> = {
  console: "local",
  unifios: "local",
  "unifi-os": "local",
  unifi_os: "local",
  os: "local",
  lan: "local",
  remote: "cloud",
  "site-manager": "cloud",
  sitemanager: "cloud",
  connector: "cloud",
};

/** Resolve a user-supplied mode, accepting the common synonyms. */
export const normalizeMode = (value: string): Mode | undefined => {
  const key = value.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(key)) return key as Mode;
  return MODE_ALIASES[key];
};

const ConfigSchema = z
  .object({
    mode: z.enum(MODES).default("local"),
    /**
     * Derived, never user-set. `mode` has a default, so its value alone cannot
     * tell you whether the user chose it — which matters when explaining why a
     * credential was ignored.
     */
    modeSource: z.enum(["explicit", "inferred", "default", "invalid"]).default("default"),
    /** Console origin, e.g. `https://192.168.1.1` or `https://10.0.0.1:8443`. Local mode. */
    baseUrl: z.string().min(1).optional(),
    /** Site Manager console id, from `GET https://api.ui.com/v1/hosts`. Cloud mode. */
    consoleId: z.string().min(1).optional(),
    /** Site Manager API key, created at unifi.ui.com. Cloud mode. */
    apiKey: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    /**
     * A 2FA code is single-use and expires in ~30s, so it is only ever useful
     * for a one-shot `unifi_protect_auth_login`, never for an unattended start.
     */
    totp: z.string().min(1).optional(),
    /**
     * On by default. Turning it off is scoped to this server's own requests via
     * an undici dispatcher, not the whole process.
     *
     * Verifying takes two things together, and one alone does nothing: the
     * console's certificate is self-signed (so NODE_EXTRA_CA_CERTS must point at
     * it) AND it carries no IP SAN — `CN=unifi.local`, SANs for `unifi.local`,
     * `localhost` and `127.0.0.1` — so UNIFI_PROTECT_HOST must be a host name
     * that resolves to the console, never its IP address.
     */
    verifyTls: z.boolean().default(true),
    allowWrites: z.boolean().default(false),
    sessionFile: z.string().min(1),
    snapshotDir: z.string().min(1),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    /** Guards against an unexpectedly huge video export blowing up the process. */
    maxDownloadBytes: z.number().int().positive().default(200_000_000),
    /** How long a cached camera id→name index stays fresh, in seconds. */
    deviceCacheTtlSeconds: z.number().int().nonnegative().max(3600).default(60),
    /**
     * IANA zone for interpreting and rendering local times. Left undefined the
     * console's own `nvr.timezone` is used, which is nearly always what someone
     * asking about "1am" means. Set this only to override a console whose zone
     * is wrong.
     */
    timeZone: z.string().min(1).optional(),
    /**
     * Names for groups of cameras, so "the front of the house" resolves without
     * anyone having to know which ids that covers.
     *
     * The console has no concept of this — it knows names, not places — and the
     * mapping is genuinely local knowledge: `Portail` and `Jardin` are both
     * outdoors, but only one faces the street. Values may be camera names or
     * ids; names are matched case-insensitively.
     */
    locations: z.record(z.string(), z.array(z.string())).default({}),
    /**
     * Configuration problems that are worth saying out loud but must never stop
     * the server. Reported by unifi_protect_auth_status and the startup banner.
     */
    issues: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine(() => {
    // Deliberately EMPTY, and deliberately still here as the place someone will
    // look to add a rule.
    //
    // Nothing about a half-configured install may be an error. `parse` throws on
    // any issue, and a throw from loadConfig exits the process — which shows in
    // the client as a bare "MCP error -32000: Connection closed" with stderr
    // swallowed, so the message explaining what to fix never reaches anyone.
    // That is the single failure this server exists to avoid, and it is easy to
    // reintroduce by adding one innocuous-looking ctx.addIssue here.
    //
    // Incomplete configurations collect into `issues` in loadConfig instead,
    // and surface through unifi_protect_auth_status as data.
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
    mode: z.enum(MODES).optional(),
    host: z.string().min(1).optional(),
    consoleId: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    verifyTls: z.boolean().optional(),
    allowWrites: z.boolean().optional(),
    sessionFile: z.string().min(1).optional(),
    snapshotDir: z.string().min(1).optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
    maxDownloadBytes: z.number().int().positive().optional(),
    deviceCacheTtlSeconds: z.number().int().nonnegative().max(3600).optional(),
    timeZone: z.string().min(1).optional(),
    locations: z.record(z.string(), z.array(z.string())).optional(),
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
/**
 * Pick the mode from whichever credentials are present when none was named.
 * An explicit UNIFI_PROTECT_MODE always wins.
 *
 * An unrecognised mode is deliberately NOT a throw: exiting over a typo is the
 * failure this whole server is built to avoid, and the client would show only
 * "Connection closed". The server comes up on the inferred mode and
 * unifi_protect_auth_status reports that the value was not understood.
 */
const resolveMode = (
  env: NodeJS.ProcessEnv,
  file: FileConfig,
): { mode: Mode; source: Config["modeSource"]; invalidMode?: string } => {
  const infer = (): Mode =>
    (trimmed(env.UNIFI_PROTECT_API_KEY) ?? file.apiKey) &&
    (trimmed(env.UNIFI_PROTECT_CONSOLE_ID) ?? file.consoleId)
      ? "cloud"
      : "local";

  const explicit = trimmed(env.UNIFI_PROTECT_MODE) ?? file.mode;
  if (explicit) {
    const resolved = normalizeMode(explicit);
    if (resolved) return { mode: resolved, source: "explicit" };
    return { mode: infer(), source: "invalid", invalidMode: explicit };
  }
  const inferred = infer();
  return { mode: inferred, source: inferred === "cloud" ? "inferred" : "default" };
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const { mode, source } = resolveMode(env, file);
  const host = trimmed(env.UNIFI_PROTECT_HOST) ?? file.host;
  const sessionFile =
    trimmed(env.UNIFI_PROTECT_SESSION_FILE) ?? file.sessionFile ?? resolveSessionPath(env);
  const snapshotDir =
    trimmed(env.UNIFI_PROTECT_SNAPSHOT_DIR) ??
    file.snapshotDir ??
    join(homedir(), ".cache", "unifi-protect");

  const issues: string[] = [];
  const { locations, issue: locationsIssue } = parseLocations(env.UNIFI_PROTECT_LOCATIONS);
  if (locationsIssue) issues.push(locationsIssue);
  const apiKey = trimmed(env.UNIFI_PROTECT_API_KEY) ?? file.apiKey;
  const consoleId = trimmed(env.UNIFI_PROTECT_CONSOLE_ID) ?? file.consoleId;
  const username = trimmed(env.UNIFI_PROTECT_USERNAME) ?? file.username;
  const password = trimmed(env.UNIFI_PROTECT_PASSWORD) ?? file.password;

  if (mode === "cloud") {
    if (apiKey && !consoleId) {
      issues.push(
        "UNIFI_PROTECT_CONSOLE_ID is not set, so cloud mode has no console to address. List " +
          'yours with: curl -H "X-API-KEY: $UNIFI_PROTECT_API_KEY" https://api.ui.com/v1/hosts',
      );
    }
    if (consoleId && !apiKey) {
      issues.push(
        "UNIFI_PROTECT_CONSOLE_ID is set but UNIFI_PROTECT_API_KEY is not. Create a key at " +
          "unifi.ui.com → Settings → API Keys.",
      );
    }
  } else {
    if (host && !username) {
      issues.push(
        "UNIFI_PROTECT_HOST is set but UNIFI_PROTECT_USERNAME is not. Local mode needs a " +
          "console login; an API key cannot authenticate the private Protect API.",
      );
    }
    if (username && !password) {
      issues.push("UNIFI_PROTECT_USERNAME is set but UNIFI_PROTECT_PASSWORD is not.");
    }
    if ((username ?? password) && !host) {
      issues.push("UNIFI_PROTECT_HOST is not set, so there is no console to reach.");
    }
    if (apiKey && !username) {
      // The trap this server keeps having to explain.
      issues.push(
        "UNIFI_PROTECT_API_KEY is set but local mode cannot use it: a console key authenticates " +
          "Ubiquiti's official Integration API, while the private API this server uses returns " +
          "401. Set UNIFI_PROTECT_USERNAME and UNIFI_PROTECT_PASSWORD, or use " +
          "UNIFI_PROTECT_MODE=cloud with UNIFI_PROTECT_CONSOLE_ID.",
      );
    }
  }
  if (source === "invalid") {
    issues.push(
      `UNIFI_PROTECT_MODE was not recognised, so ${mode} mode was assumed. Valid values: ` +
        `${MODES.join(", ")}.`,
    );
  }

  return ConfigSchema.parse({
    mode,
    modeSource: source,
    issues,
    baseUrl: host ? normalizeBaseUrl(host) : undefined,
    consoleId,
    apiKey,
    username,
    password,
    totp: trimmed(env.UNIFI_PROTECT_TOTP),
    verifyTls: parseBool(env.UNIFI_PROTECT_VERIFY_TLS) ?? file.verifyTls,
    allowWrites: parseBool(env.UNIFI_PROTECT_ALLOW_WRITES) ?? file.allowWrites,
    sessionFile: expandTilde(sessionFile),
    snapshotDir: expandTilde(snapshotDir),
    maxRetries: parseIntOpt(env.UNIFI_PROTECT_MAX_RETRIES) ?? file.maxRetries,
    maxDownloadBytes: parseIntOpt(env.UNIFI_PROTECT_MAX_DOWNLOAD_BYTES) ?? file.maxDownloadBytes,
    deviceCacheTtlSeconds:
      parseIntOpt(env.UNIFI_PROTECT_DEVICE_CACHE_TTL) ?? file.deviceCacheTtlSeconds,
    timeZone: trimmed(env.UNIFI_PROTECT_TIMEZONE) ?? file.timeZone,
    locations: locations ?? file.locations,
  });
};

/**
 * Read the location map from the environment, where it has to arrive as JSON.
 *
 * A malformed value must never stop the server (rule 2): it collects into
 * `issues` and the map is simply empty, so every camera stays reachable by id.
 */
const parseLocations = (
  raw: string | undefined,
): { locations?: Record<string, string[]>; issue?: string } => {
  const text = trimmed(raw);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const result = z.record(z.string(), z.array(z.string())).safeParse(parsed);
    if (!result.success) {
      return {
        issue:
          "UNIFI_PROTECT_LOCATIONS must be a JSON object of name -> array of camera names, e.g. " +
          '{"front":["Carillon","Portail"]}. It was ignored.',
      };
    }
    return { locations: result.data };
  } catch {
    return { issue: "UNIFI_PROTECT_LOCATIONS is not valid JSON. It was ignored." };
  }
};

/**
 * The origin every private-API request is built on. Cloud mode addresses the
 * console through the Site Manager connector, which forwards the whole
 * `/proxy/protect/...` tree — the private API included — so both modes share
 * one client and one set of paths.
 */
export const consoleOrigin = (config: Config): string | undefined => {
  if (config.mode === "cloud") {
    return config.consoleId ? `${CLOUD_BASE}/${config.consoleId}` : undefined;
  }
  return config.baseUrl;
};

/** True once the server has everything it needs to reach a console. */
export const isConfigured = (config: Config): boolean =>
  config.mode === "cloud"
    ? Boolean(config.consoleId && config.apiKey)
    : Boolean(config.baseUrl && config.username && config.password);

/**
 * Returned by unifi_protect_auth_status and printed to stderr at startup. Prose
 * rather than a code, because this is the text someone acts on when nothing
 * works — and the server can no longer signal it by refusing to start.
 */
export const setupInstructions = (config: Config): string[] => {
  if (isConfigured(config)) return [];

  const modeNote =
    config.modeSource === "invalid"
      ? [
          `UNIFI_PROTECT_MODE was not recognised, so ${config.mode} mode was assumed. Valid ` +
            `values are: ${MODES.join(", ")}.`,
        ]
      : [];

  if (config.mode === "cloud") {
    return [
      ...modeNote,
      "Cloud mode reaches your console through Ubiquiti's Site Manager connector, so it needs " +
        "no local account, no password and no LAN access — and api.ui.com has a real " +
        "certificate, so none of the self-signed TLS setup applies.",
      "Create an API key at https://unifi.ui.com → Settings → API Keys, and set it as " +
        "UNIFI_PROTECT_API_KEY.",
      'Find your console id with: curl -H "X-API-KEY: $UNIFI_PROTECT_API_KEY" ' +
        "https://api.ui.com/v1/hosts — then set UNIFI_PROTECT_CONSOLE_ID to the `id` of the " +
        "console running Protect (a UNVR, or a UDM/Cloud Key with Protect installed).",
      // The failure people actually hit: the console is visible in the web
      // dashboard but sits outside the org the key belongs to, and the
      // connector then answers 403 rather than 401.
      "If a call comes back 403 'user cannot access host in the organization', the key is valid " +
        "but was issued in an organization that does not include that console. Create the key " +
        "from the account that owns it.",
      "Set UNIFI_PROTECT_MODE=local instead to talk to the console directly on your LAN.",
    ];
  }

  return [
    ...modeNote,
    "No UniFi Protect console is configured, so only unifi_protect_auth_status is registered.",
    "Set UNIFI_PROTECT_HOST to your console's address — the IP or hostname of the UDM Pro, " +
      "UNVR or Cloud Key, e.g. 192.168.1.1 (https:// is assumed, and a :port is preserved).",
    "Set UNIFI_PROTECT_USERNAME and UNIFI_PROTECT_PASSWORD to a console login.",
    // The thing everyone tries first. Saying so here costs one line and saves
    // an afternoon: the key is accepted by the official Integration API, so it
    // looks valid, while every private-API call answers 401.
    "An API key will NOT work in local mode. A key issued on the console authenticates " +
      "Ubiquiti's official Integration API, but the private API this server uses refuses it " +
      "(verified on Protect 7.2.105: /proxy/protect/integration/v1/* returns 200 while " +
      "/proxy/protect/api/* returns 401). A username and password is the only local option.",
    "Create a dedicated LOCAL user for this rather than reusing your own: UniFi OS → Settings → " +
      "Admins & Users → Add User → Local Access Only, and give it Protect permissions only. A " +
      "Ubiquiti cloud (SSO) account may fail local login entirely, and a local account keeps the " +
      "blast radius to Protect.",
    "Give that user View-Only rights unless you intend to set UNIFI_PROTECT_ALLOW_WRITES=1 — " +
      "with writes off the mutating tools are not registered at all, so they cannot be called.",
    "If the account has 2FA, pass a current code once via unifi_protect_auth_login; the session " +
      "is then cached and reused. A code in UNIFI_PROTECT_TOTP expires in about 30 seconds, so " +
      "it is no use for an unattended start.",
    // The alternative most people do not know exists.
    "Alternatively set UNIFI_PROTECT_MODE=cloud with UNIFI_PROTECT_API_KEY and " +
      "UNIFI_PROTECT_CONSOLE_ID: that needs no local account at all, works off-LAN, and avoids " +
      "the console's self-signed certificate entirely.",
  ];
};
