import {
  createSessionProvider,
  ProtectAuthError,
  type Logger,
  type SessionProvider,
  type SessionStatus,
} from "@mgcrea/unifi-protect";

import type { Config } from "#/config";

/**
 * Session providers, adapting `@mgcrea/unifi-protect` to this server's config.
 *
 * The handshake itself — CSRF prefetch, the 499 that means 2FA, the single
 * in-flight login because the console rotates its CSRF token on every one, the
 * session cached 0600 and restored across restarts — lives in the client
 * package and used to live here too, in a copy that had already begun to drift.
 * What stays here is only what is specific to being an MCP server: which of the
 * three providers applies, and error prose that names this server's tools.
 */

/** Cloud mode: the Site Manager connector authenticates every request from the key. */
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

/**
 * Stands in when nothing is configured.
 *
 * `createServer` stays total — it always builds a client — so something has to
 * answer when a caller reaches one that has no credentials. No tool that could
 * use it is registered, so this should be unreachable; if it ever is reached,
 * the message names the tool that explains the fix rather than failing with a
 * type error about a missing password.
 */
const refuseUnconfigured = (): never => {
  throw new ProtectAuthError(
    "No console credentials are configured. Call unifi_protect_auth_status for the setup steps.",
  );
};

export const notConfiguredSessionProvider = (): SessionProvider => {
  const status: SessionStatus = {
    authenticated: false,
    source: "none",
    username: undefined,
    savedAt: undefined,
  };
  return {
    headers: async () => refuseUnconfigured(),
    invalidate: () => {},
    login: async () => refuseUnconfigured(),
    logout: async () => {},
    describe: () => status,
  };
};

/**
 * Local mode: a real UniFi OS login.
 *
 * The client package's own two-factor message tells a long-running bridge to
 * create a user without 2FA, which is the right advice there and the wrong
 * advice here — this server has `unifi_protect_auth_login`, which exists
 * precisely so a code can be handed over once and the session reused after. So
 * the error is re-thrown with prose that names it.
 */
const retellTwoFactor = (err: unknown): never => {
  if (err instanceof ProtectAuthError && err.needsTwoFactor) {
    throw new ProtectAuthError(
      "The console requires a two-factor code. Call unifi_protect_auth_login with a current " +
        "code from your authenticator app — the session is cached afterwards, so this is a " +
        "one-off.",
      { needsTwoFactor: true },
    );
  }
  throw err;
};

export const createConsoleSessionProvider = (opts: {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
}): SessionProvider => {
  const { config } = opts;
  if (!config.baseUrl || !config.username || !config.password) {
    return notConfiguredSessionProvider();
  }

  const inner = createSessionProvider({
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    ...(config.totp ? { totp: config.totp } : {}),
    sessionFile: config.sessionFile,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  return {
    headers: () => inner.headers().catch(retellTwoFactor),
    invalidate: () => inner.invalidate(),
    login: (totp?: string) => inner.login(totp).catch(retellTwoFactor),
    logout: () => inner.logout(),
    describe: () => inner.describe(),
  };
};
