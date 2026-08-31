import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProtectAuthError } from "@mgcrea/unifi-protect";
import { afterAll, describe, expect, it } from "vitest";

import {
  apiKeySessionProvider,
  createConsoleSessionProvider,
  notConfiguredSessionProvider,
} from "#/client/session";
import type { Config } from "#/config";

import { fetchMock } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "unifi-protect-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = (over: Partial<Config> = {}): Config =>
  ({
    mode: "local",
    modeSource: "default",
    issues: [],
    baseUrl: "https://192.168.1.1",
    username: "mcp",
    password: "secret",
    verifyTls: false,
    trustFile: join(dir, "trust.json"),
    allowWrites: false,
    sessionFile: join(dir, `session-${Math.random()}.json`),
    snapshotDir: dir,
    maxRetries: 0,
    maxDownloadBytes: 1000,
    deviceCacheTtlSeconds: 60,
    locations: {},
    ...over,
  }) as Config;

describe("apiKeySessionProvider", () => {
  it("authenticates with a single x-api-key and holds no session", async () => {
    const session = apiKeySessionProvider("key-123");
    expect(await session.headers()).toEqual({ "x-api-key": "key-123" });
    expect(session.describe()).toMatchObject({ authenticated: true, source: "api-key" });
  });

  it("treats login and logout as no-ops, since there is no handshake", async () => {
    const session = apiKeySessionProvider("key-123");
    await expect(session.login()).resolves.toMatchObject({ source: "api-key" });
    await expect(session.logout()).resolves.toBeUndefined();
    expect(await session.headers()).toEqual({ "x-api-key": "key-123" });
  });
});

describe("notConfiguredSessionProvider", () => {
  it("names the tool that explains the fix rather than failing obscurely", async () => {
    const session = notConfiguredSessionProvider();
    await expect(session.headers()).rejects.toThrow(/unifi_protect_auth_status/);
    expect(session.describe()).toMatchObject({ authenticated: false, source: "none" });
  });
});

describe("createConsoleSessionProvider", () => {
  it("degrades to the not-configured provider when credentials are missing", async () => {
    const session = createConsoleSessionProvider({
      config: config({ password: undefined }),
      fetch: fetchMock(async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(session.headers()).rejects.toThrow(/unifi_protect_auth_status/);
  });

  it("retells a two-factor challenge so it names this server's login tool", async () => {
    // The client package tells a long-running bridge to create a user without
    // 2FA, which is the wrong advice here: unifi_protect_auth_login exists so a
    // code can be handed over once and the session reused afterwards.
    const session = createConsoleSessionProvider({
      config: config(),
      fetch: fetchMock(async (url) =>
        String(url).includes("/api/auth/login")
          ? new Response("2fa token required", { status: 499 })
          : new Response("<html></html>", { headers: { "x-csrf-token": "csrf" } }),
      ) as unknown as typeof fetch,
    });

    await expect(session.login()).rejects.toThrow(/unifi_protect_auth_login/);
    await expect(session.login()).rejects.toMatchObject({ needsTwoFactor: true });
  });

  it("passes a non-2FA login failure through untouched", async () => {
    const session = createConsoleSessionProvider({
      config: config(),
      fetch: fetchMock(
        async () => new Response("nope", { status: 401 }),
      ) as unknown as typeof fetch,
    });

    const err = await session.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtectAuthError);
    expect((err as ProtectAuthError).needsTwoFactor).toBe(false);
    expect((err as Error).message).toMatch(/Local Access Only/);
  });

  it("logs in through the client package and sends its cookie and CSRF token", async () => {
    const fetchImpl = fetchMock(async (url) =>
      String(url).includes("/api/auth/login")
        ? new Response("{}", {
            status: 200,
            headers: { "set-cookie": "TOKEN=abc; Path=/", "x-updated-csrf-token": "fresh" },
          })
        : new Response("<html></html>", { headers: { "x-csrf-token": "stale" } }),
    );

    const session = createConsoleSessionProvider({
      config: config(),
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await session.headers()).toEqual({ cookie: "TOKEN=abc", "x-csrf-token": "fresh" });
    expect(session.describe()).toMatchObject({ authenticated: true, username: "mcp" });
  });
});
