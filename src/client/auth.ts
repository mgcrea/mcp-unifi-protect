import { ProtectAuthError } from "#/client/errors";
import {
  clearSession,
  loadSession,
  saveSession,
  type PersistedSession,
} from "#/client/session-store";
import { LOGIN_PATH, type Config } from "#/config";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/** The two headers that authenticate every request to a UniFi OS console. */
/**
 * The headers that authenticate one request. Deliberately an open record rather
 * than the cookie/CSRF pair it used to be: local mode sends
 * `cookie` + `x-csrf-token`, cloud mode sends a single `x-api-key`, and the
 * client should not have to know which it is holding.
 */
export type SessionHeaders = Record<string, string>;

export type SessionStatus = {
  authenticated: boolean;
  /** Where the live session came from, for unifi_protect_auth_status. */
  source: "none" | "restored" | "login" | "api-key";
  username: string | undefined;
  savedAt: string | undefined;
};

/**
 * A pluggable source of console session headers. The client calls `headers()`
 * on every request and `invalidate()` on a 401 to force the next call to
 * re-run the handshake.
 */
export type SessionProvider = {
  headers(): Promise<SessionHeaders>;
  invalidate(): void;
  /** Force a fresh handshake now, optionally with a 2FA code. Used by auth_login. */
  login(totp?: string): Promise<SessionStatus>;
  /** Drop the session in memory and on disk. */
  logout(): Promise<void>;
  describe(): SessionStatus;
};

export type SessionProviderOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
};

/**
 * Read one header, collapsing undici's `string | string[] | undefined` shape.
 * Multi-value headers (the Set-Cookie shape) collapse to their first entry,
 * which is all the handshake needs — the session is a single cookie.
 */
const header = (res: Response, name: string): string | undefined =>
  res.headers.get(name) ?? undefined;

/**
 * Keep only the `TOKEN=value` pair, dropping the cookie's attributes (Path,
 * Expires, HttpOnly, …). Sending those attributes back on a request header is
 * malformed and the console rejects the session.
 */
const bareCookie = (setCookie: string): string => {
  const semicolon = setCookie.indexOf(";");
  return semicolon === -1 ? setCookie : setCookie.slice(0, semicolon);
};

/**
 * Whether a login response is asking for a second factor rather than refusing
 * the password. Protect answers 499 for this; some firmwares use a 401 with a
 * body naming the requirement, so both are probed.
 */
const isTwoFactorChallenge = (status: number, body: string): boolean =>
  status === 499 || /2fa|two[- ]factor|mfa|otp/i.test(body);

export const createSessionProvider = (opts: SessionProviderOptions): SessionProvider => {
  const { config } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const logger = opts.logger;

  let session: PersistedSession | undefined;
  let source: SessionStatus["source"] = "none";
  // A single in-flight promise coordinates concurrent callers. Unlike a locally
  // signed token, a console login is a network call that must not be issued
  // twice: the console rotates the CSRF token on every successful login, so two
  // races leave whichever finished last, which need not be the one whose token
  // the caller went on to use.
  let inflight: Promise<PersistedSession> | undefined;
  let restored = false;

  const requireCredentials = (): { baseUrl: string; username: string; password: string } => {
    if (!config.baseUrl || !config.username || !config.password) {
      throw new ProtectAuthError(
        "No console credentials are configured. Call unifi_protect_auth_status for the setup steps.",
      );
    }
    return { baseUrl: config.baseUrl, username: config.username, password: config.password };
  };

  /**
   * Fetch a CSRF token from the console root. UniFi OS gates login behind CSRF
   * protection, so a first login on a cold start has nothing to present until
   * this runs.
   */
  const fetchCsrfToken = async (baseUrl: string): Promise<string | undefined> => {
    try {
      const res = await fetchImpl(baseUrl, { method: "GET", redirect: "manual" });
      return header(res, "x-csrf-token");
    } catch (err) {
      logger?.debug?.(`could not prefetch a CSRF token: ${String(err)}`);
      return undefined;
    }
  };

  /** Run the UniFi OS handshake and return a complete session. */
  const handshake = async (totp?: string): Promise<PersistedSession> => {
    const { baseUrl, username, password } = requireCredentials();
    const url = `${baseUrl}${LOGIN_PATH}`;
    const code = totp ?? config.totp;

    const attempt = async (csrf: string | undefined): Promise<Response> =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: JSON.stringify({
          username,
          password,
          // `token` is what the console calls the 2FA code. Omitted entirely
          // rather than sent as null, which some firmwares reject outright.
          ...(code ? { token: code } : {}),
          rememberMe: true,
        }),
        redirect: "manual",
      });

    logger?.debug?.(`logging in to ${baseUrl} as ${username}`);
    let res = await attempt(session?.csrfToken);

    // Rejected with no CSRF token to offer: fetch one from the root document
    // and retry the login exactly once.
    if (!res.ok && !session?.csrfToken) {
      const csrf = await fetchCsrfToken(baseUrl);
      if (csrf) {
        logger?.debug?.("retrying login with a freshly fetched CSRF token");
        res = await attempt(csrf);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (isTwoFactorChallenge(res.status, body)) {
        throw new ProtectAuthError(
          "The console requires a two-factor code. Call unifi_protect_auth_login with a current " +
            "code from your authenticator app — the session is cached afterwards, so this is a " +
            "one-off.",
          { needsTwoFactor: true },
        );
      }
      throw new ProtectAuthError(
        `Login to ${baseUrl} as ${username} failed: HTTP ${res.status} ${res.statusText}. ` +
          `Check the username and password, and note that a Ubiquiti cloud (SSO) account often ` +
          `cannot log in locally — create a Local Access Only user instead.`,
      );
    }

    // The console rotates the CSRF token on a successful login and returns the
    // new one in X-Updated-CSRF-Token. Preferring that over X-CSRF-Token matters:
    // taking the stale one makes the FIRST request succeed and every later one
    // fail, which reads like an expiry problem and is not one.
    const csrfToken = header(res, "x-updated-csrf-token") ?? header(res, "x-csrf-token");
    const setCookie = res.headers.getSetCookie()[0] ?? header(res, "set-cookie");

    if (!csrfToken || !setCookie) {
      throw new ProtectAuthError(
        `Login to ${baseUrl} succeeded (HTTP ${res.status}) but returned no ` +
          `${!setCookie ? "session cookie" : "CSRF token"}. This usually means the host is not a ` +
          `UniFi OS console — check UNIFI_PROTECT_HOST points at the console itself, not at a ` +
          `reverse proxy in front of it.`,
      );
    }

    const next: PersistedSession = {
      cookie: bareCookie(setCookie),
      csrfToken,
      baseUrl,
      username,
      savedAt: new Date(opts.now?.() ?? Date.now()).toISOString(),
    };
    await saveSession(config.sessionFile, next).catch((err: unknown) => {
      // A session that cannot be persisted is still usable in memory; failing
      // the login over it would be a worse trade.
      logger?.warn?.(`could not persist the session to ${config.sessionFile}: ${String(err)}`);
    });
    return next;
  };

  /**
   * Reuse a session from disk when it belongs to the console and account we are
   * configured for. A session for a different host or user is not merely
   * useless, it would authenticate as the wrong identity.
   */
  const restore = async (): Promise<PersistedSession | undefined> => {
    if (restored) return undefined;
    restored = true;
    const persisted = await loadSession(config.sessionFile);
    if (!persisted) return undefined;
    if (persisted.baseUrl !== config.baseUrl || persisted.username !== config.username) {
      logger?.debug?.("ignoring a persisted session issued for a different console or user");
      return undefined;
    }
    logger?.debug?.(`restored a session from ${config.sessionFile}`);
    return persisted;
  };

  const ensure = async (totp?: string): Promise<PersistedSession> => {
    if (session) return session;

    // Try disk before the network, but only once per process: a restored
    // session that turns out to be expired comes back as a 401, which
    // invalidate() clears and the next call logs in properly.
    const fromDisk = await restore();
    if (fromDisk) {
      session = fromDisk;
      source = "restored";
      return session;
    }

    if (!inflight) {
      inflight = handshake(totp).finally(() => {
        inflight = undefined;
      });
    }
    session = await inflight;
    source = "login";
    return session;
  };

  return {
    async headers(): Promise<SessionHeaders> {
      const live = await ensure();
      return { cookie: live.cookie, "x-csrf-token": live.csrfToken };
    },

    invalidate(): void {
      session = undefined;
      // A restored-but-expired session must not be restored a second time, or
      // the 401 retry loop would keep replaying the same dead cookie until it
      // runs out of attempts and reports a credentials problem that isn't one.
      restored = true;
    },

    async login(totp?: string): Promise<SessionStatus> {
      session = undefined;
      restored = true;
      session = await handshake(totp);
      source = "login";
      return this.describe();
    },

    async logout(): Promise<void> {
      session = undefined;
      restored = true;
      source = "none";
      await clearSession(config.sessionFile);
    },

    describe(): SessionStatus {
      return {
        authenticated: session !== undefined,
        source,
        username: session?.username ?? config.username,
        savedAt: session?.savedAt,
      };
    },
  };
};

/**
 * Cloud mode's provider. The Site Manager connector authenticates the request
 * itself, so there is no login, no cookie, no CSRF token and nothing to
 * invalidate — a 401 here means the key is wrong or the console is outside the
 * key's organization, and retrying cannot fix either.
 */
export const apiKeySessionProvider = (apiKey: string): SessionProvider => {
  const status: SessionStatus = {
    authenticated: true,
    source: "api-key",
    username: undefined,
    savedAt: undefined,
  };
  return {
    headers: async () => ({ "x-api-key": apiKey }),
    invalidate: () => {},
    login: async () => status,
    logout: async () => {},
    describe: () => status,
  };
};

/** For tests: fixed headers, no network, no disk. */
export const staticSessionProvider = (
  headers: SessionHeaders = { cookie: "TOKEN=test", "x-csrf-token": "csrf-test" },
): SessionProvider => ({
  headers: async () => headers,
  invalidate: () => {},
  login: async () => ({
    authenticated: true,
    source: "login",
    username: "test",
    savedAt: undefined,
  }),
  logout: async () => {},
  describe: () => ({ authenticated: true, source: "login", username: "test", savedAt: undefined }),
});
