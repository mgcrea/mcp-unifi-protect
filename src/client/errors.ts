/**
 * Errors this server raises on its own behalf.
 *
 * The console-facing taxonomy — `ProtectApiError`, `ProtectAuthError`,
 * `ProtectTlsError` — belongs to `@mgcrea/unifi-protect` and is re-exported
 * here so callers still have one import for all of them.
 */
export { ProtectApiError, ProtectAuthError, ProtectTlsError } from "@mgcrea/unifi-protect";

/** Thrown when a write path is reached while UNIFI_PROTECT_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set UNIFI_PROTECT_ALLOW_WRITES=1 to register the mutating tools.`,
    );
  }
}

/** Thrown when the server is asked to reach a console it has no credentials for. */
export class NotConfiguredError extends Error {
  override readonly name = "NotConfiguredError";

  constructor() {
    super(
      "No UniFi Protect console is configured. Call unifi_protect_auth_status for the setup steps.",
    );
  }
}
