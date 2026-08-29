/** A non-2xx answer from the console. */
export class ProtectApiError extends Error {
  override readonly name = "ProtectApiError";
  readonly status: number;
  /** The request path, so an error names what failed without a stack trace. */
  readonly path: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: { status: number; path?: string | undefined; errors?: unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.path = opts.path;
    this.errors = opts.errors;
  }
}

/** The console rejected the credentials, or 2FA is required and was not supplied. */
export class ProtectAuthError extends Error {
  override readonly name = "ProtectAuthError";
  /** True when the console asked for a 2FA code rather than refusing the password. */
  readonly needsTwoFactor: boolean;

  constructor(message: string, opts: { needsTwoFactor?: boolean } = {}) {
    super(message);
    this.needsTwoFactor = opts.needsTwoFactor ?? false;
  }
}

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
