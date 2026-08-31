import {
  createTransport,
  resolveTrust,
  type Logger,
  type ProtectTransport,
} from "@mgcrea/unifi-protect";

import type { Config } from "#/config";

/**
 * The one place TLS is decided.
 *
 * UniFi consoles present a self-signed certificate for `CN=unifi.local`, with
 * SANs for `unifi.local`, `localhost` and `127.0.0.1` — and no IP SAN. Reached
 * by IP, as almost everyone reaches it, host name verification fails however
 * the certificate is trusted, which is why this space universally ends at
 * `rejectUnauthorized: false` and leaves the login handshake open to anything
 * on the LAN that can answer on port 443.
 *
 * `@mgcrea/unifi-protect` pins instead: it reads the certificate once, then
 * verifies every later connection against that one certificate as its own
 * anchor and replaces the host name check with a fingerprint comparison. This
 * module only decides *when* that happens.
 *
 * **Resolution is deferred to the first request, and that is the whole point.**
 * `resolveTrust` opens a socket, and `createServer` must not: rule 2 of this
 * fleet is that the server starts without credentials or connectivity and
 * explains itself through `unifi_protect_auth_status`. A console that is asleep
 * or misaddressed has to surface as a failed tool call carrying a message, not
 * as a server that never finished starting — which reaches the client as a bare
 * "Connection closed" with stderr swallowed.
 */
export type LazyTransport = {
  fetch: typeof fetch;
  /** Releases the dispatcher's keep-alive sockets, which hold the event loop open. */
  close: () => Promise<void>;
};

export type LazyTransportOptions = {
  config: Config;
  logger?: Logger | undefined;
};

/** Host and port a TLS pin is keyed on, taken from the configured origin. */
const targetOf = (baseUrl: string): { host: string; port: number } => {
  const url = new URL(baseUrl);
  return { host: url.hostname, port: url.port ? Number(url.port) : 443 };
};

export const createLazyTransport = (opts: LazyTransportOptions): LazyTransport => {
  const { config, logger } = opts;

  // api.ui.com presents a real certificate, so cloud mode wants the platform
  // fetch and nothing else: pinning there would add a failure mode and buy
  // nothing, and the console's self-signed certificate is never even seen.
  if (config.mode === "cloud" || !config.baseUrl) {
    return { fetch, close: async () => undefined };
  }

  const { host, port } = targetOf(config.baseUrl);
  let pending: Promise<ProtectTransport> | undefined;

  // Memoised on the promise rather than the result, so concurrent first calls
  // share one certificate capture instead of racing to write the trust file.
  const transport = (): Promise<ProtectTransport> =>
    (pending ??= resolveTrust({
      host,
      port,
      trustFile: config.trustFile,
      ...(config.fingerprint ? { expectedFingerprint: config.fingerprint } : {}),
      insecure: !config.verifyTls,
      ...(logger ? { logger } : {}),
    }).then((policy) => createTransport(policy, host)));

  return {
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      (await transport()).fetch(input, init)) as typeof fetch,
    close: async () => {
      if (!pending) return;
      // A capture that failed left no dispatcher to close, and rethrowing here
      // would turn shutdown into a second error on top of the first.
      await pending.then((t) => t.close()).catch(() => undefined);
    },
  };
};
