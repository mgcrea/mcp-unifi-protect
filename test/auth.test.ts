import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionProvider } from "../src/client/auth.js";
import { ProtectAuthError } from "../src/client/errors.js";
import type { Config } from "../src/config.js";
import { calledInit, calledUrl, fetchMock, type FetchLike } from "./helpers.js";

let sessionFile: string;

const config = (overrides: Partial<Config> = {}): Config => ({
  baseUrl: "https://192.168.1.1",
  username: "mcp",
  password: "secret",
  verifyTls: false,
  allowWrites: false,
  sessionFile,
  snapshotDir: join(tmpdir(), "snapshots"),
  maxRetries: 3,
  maxDownloadBytes: 200_000_000,
  deviceCacheTtlSeconds: 60,
  ...overrides,
});

/** A login response carrying a cookie and a rotated CSRF token. */
const loginOk = (opts: { cookie?: string; updated?: string; csrf?: string } = {}): Response => {
  const headers = new Headers();
  headers.append("set-cookie", opts.cookie ?? "TOKEN=jwt-value; Path=/; HttpOnly; Secure");
  if (opts.updated !== undefined) headers.set("x-updated-csrf-token", opts.updated);
  if (opts.csrf !== undefined) headers.set("x-csrf-token", opts.csrf);
  return new Response("{}", { status: 200, headers });
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "unifi-protect-auth-"));
  sessionFile = join(dir, "session.json");
});

describe("the UniFi OS handshake", () => {
  it("sends cookie and CSRF headers built from the login response", async () => {
    const fetchImpl = fetchMock(async () => loginOk({ updated: "rotated-csrf" }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await session.headers()).toEqual({
      // The attributes are stripped: sending Path/HttpOnly back on a request
      // header is malformed and the console rejects the session.
      cookie: "TOKEN=jwt-value",
      "x-csrf-token": "rotated-csrf",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(calledUrl(fetchImpl)).toBe("https://192.168.1.1/api/auth/login");
  });

  it("prefers X-Updated-CSRF-Token over X-CSRF-Token", async () => {
    // Taking the stale one makes the FIRST request succeed and every later one
    // fail, which reads like an expiry problem and is not one.
    const fetchImpl = fetchMock(async () => loginOk({ updated: "new", csrf: "stale" }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect((await session.headers())["x-csrf-token"]).toBe("new");
  });

  it("fetches a CSRF token from the root and retries once when login is rejected", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      // First login attempt: no CSRF token held, rejected.
      .mockResolvedValueOnce(new Response("nope", { status: 403 }))
      // The root document hands one out.
      .mockResolvedValueOnce(
        new Response("<html>", { status: 200, headers: { "x-csrf-token": "from-root" } }),
      )
      .mockResolvedValueOnce(loginOk({ updated: "rotated" }));

    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect((await session.headers()).cookie).toBe("TOKEN=jwt-value");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calledUrl(fetchImpl, 1)).toBe("https://192.168.1.1");
    expect(
      calledInit<{ headers: Record<string, string> }>(fetchImpl, 2).headers["x-csrf-token"],
    ).toBe("from-root");
  });

  it("reports a two-factor challenge as such rather than as a bad password", async () => {
    const fetchImpl = fetchMock(async () => new Response("2FA required", { status: 499 }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(session.headers()).rejects.toThrow(ProtectAuthError);
    await expect(session.headers()).rejects.toThrow(/two-factor/i);
  });

  it("sends the 2FA code as `token` when one is supplied to login()", async () => {
    const fetchImpl = fetchMock(async () => loginOk({ updated: "csrf" }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await session.login("123456");
    const init = calledInit<{ body: string }>(fetchImpl);
    expect(JSON.parse(init.body)).toMatchObject({ username: "mcp", token: "123456" });
  });

  it("explains a login that returns no cookie, rather than failing later", async () => {
    // What a reverse proxy in front of the console looks like.
    const fetchImpl = fetchMock(
      async () => new Response("{}", { status: 200, headers: { "x-csrf-token": "c" } }),
    );
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(session.headers()).rejects.toThrow(/no session cookie/i);
  });

  it("logs in only once for concurrent callers", async () => {
    // The console rotates the CSRF token on every login, so two racing
    // handshakes leave whichever finished last — which need not be the one
    // whose token the caller went on to use.
    const fetchImpl = fetchMock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return loginOk({ updated: "csrf" });
    });
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([session.headers(), session.headers(), session.headers()]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("session persistence", () => {
  it("writes the session with owner-only permissions", async () => {
    const fetchImpl = fetchMock(async () => loginOk({ updated: "csrf" }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await session.headers();

    const mode = (await stat(sessionFile)).mode & 0o777;
    expect(mode).toBe(0o600);
    const saved = JSON.parse(await readFile(sessionFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ cookie: "TOKEN=jwt-value", csrfToken: "csrf", username: "mcp" });
  });

  it("reuses a persisted session instead of logging in again", async () => {
    const first = fetchMock(async () => loginOk({ updated: "csrf" }));
    await createSessionProvider({
      config: config(),
      fetch: first as unknown as typeof fetch,
    }).headers();

    const second = fetchMock(async () => loginOk({ updated: "other" }));
    const restored = createSessionProvider({
      config: config(),
      fetch: second as unknown as typeof fetch,
    });
    expect((await restored.headers())["x-csrf-token"]).toBe("csrf");
    expect(second).not.toHaveBeenCalled();
    expect(restored.describe().source).toBe("restored");
  });

  it("ignores a session issued for a different console", async () => {
    const first = fetchMock(async () => loginOk({ updated: "csrf" }));
    await createSessionProvider({
      config: config(),
      fetch: first as unknown as typeof fetch,
    }).headers();

    // Reusing this would authenticate against the wrong console entirely.
    const second = fetchMock(async () => loginOk({ updated: "fresh" }));
    const moved = createSessionProvider({
      config: config({ baseUrl: "https://10.0.0.9" }),
      fetch: second as unknown as typeof fetch,
    });
    expect((await moved.headers())["x-csrf-token"]).toBe("fresh");
    expect(second).toHaveBeenCalled();
  });

  it("does not replay a restored session after it is invalidated", async () => {
    // Otherwise the 401 retry loop replays the same dead cookie until it runs
    // out of attempts and reports a credentials problem that is not one.
    const first = fetchMock(async () => loginOk({ updated: "csrf" }));
    await createSessionProvider({
      config: config(),
      fetch: first as unknown as typeof fetch,
    }).headers();

    const second = fetchMock(async () => loginOk({ updated: "fresh" }));
    const provider = createSessionProvider({
      config: config(),
      fetch: second as unknown as typeof fetch,
    });
    expect((await provider.headers())["x-csrf-token"]).toBe("csrf");
    provider.invalidate();
    expect((await provider.headers())["x-csrf-token"]).toBe("fresh");
  });

  it("logout removes the session file and is idempotent", async () => {
    const fetchImpl = fetchMock(async () => loginOk({ updated: "csrf" }));
    const session = createSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await session.headers();
    await session.logout();
    await expect(stat(sessionFile)).rejects.toThrow();
    await expect(session.logout()).resolves.toBeUndefined();
  });
});
