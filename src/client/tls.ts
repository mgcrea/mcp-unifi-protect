import { Agent, fetch as undiciFetch } from "undici";

import type { Logger } from "#/client/auth";

/**
 * The one place TLS is decided.
 *
 * UniFi consoles ship a self-signed certificate, and Node's native `fetch`
 * ignores a `node:https` Agent — the only scoped way to relax verification is an
 * undici dispatcher. That is why this server carries a third runtime dependency:
 * the alternative, NODE_TLS_REJECT_UNAUTHORIZED=0, is process-global and
 * disables verification for every other request the process ever makes.
 *
 * This replaced exactly that process-wide switch, which had been adopted on the
 * belief that undici could not be imported and a dispatcher therefore could not
 * be scoped. It can — see below.
 *
 * **The `fetch` here must be undici's own, not the global one.** Node's built-in
 * fetch is a *bundled copy* of undici, and it rejects a dispatcher constructed
 * from the separately-installed package with a bare `UND_ERR_INVALID_ARG`,
 * surfacing as an unexplained "fetch failed". Passing undici's own fetch keeps
 * both sides on one class. Verification is on by default, so the platform fetch
 * remains the common path.
 *
 * Note what a pinned certificate can and cannot fix. These consoles present
 * `CN=unifi.local` with SANs for `unifi.local`, `localhost` and `127.0.0.1` —
 * and **no IP SAN**. Reached by IP, verification fails on the host name however
 * the certificate is trusted. Measured with `curl --cacert`: by host name
 * `ssl_verify=0`, by IP `ssl_verify=1`. So verifying requires BOTH
 * NODE_EXTRA_CA_CERTS and a host name that resolves to the console.
 */
export const createHttpFetch = (opts: { insecureTls: boolean; logger?: Logger }): typeof fetch => {
  if (!opts.insecureTls) return fetch;

  opts.logger?.warn?.(
    "TLS certificate verification is DISABLED for this server's requests " +
      "(UNIFI_PROTECT_VERIFY_TLS=false). To verify instead, address the console by a host name " +
      "that resolves to it — its certificate has no IP SAN — and point NODE_EXTRA_CA_CERTS at " +
      "the console's certificate.",
  );

  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  // undici's fetch/Response are structurally the WHATWG ones the rest of the
  // client uses; the cast bridges the two nominal type declarations and is
  // confined to this file.
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as string, { ...init, dispatcher } as never)) as unknown as typeof fetch;
};
