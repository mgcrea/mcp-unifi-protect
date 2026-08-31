import { describe, expect, it, vi } from "vitest";

import { createLazyTransport } from "#/client/transport";
import type { Config } from "#/config";

const resolveTrust = vi.hoisted(() => vi.fn());
const createTransport = vi.hoisted(() => vi.fn());

vi.mock("@mgcrea/unifi-protect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mgcrea/unifi-protect")>()),
  resolveTrust,
  createTransport,
}));

const config = (over: Partial<Config> = {}): Config =>
  ({
    mode: "local",
    modeSource: "default",
    issues: [],
    baseUrl: "https://192.168.1.1",
    username: "mcp",
    password: "secret",
    verifyTls: true,
    trustFile: "/tmp/unifi-protect-test-trust.json",
    allowWrites: false,
    sessionFile: "/tmp/unifi-protect-test-session.json",
    snapshotDir: "/tmp",
    maxRetries: 0,
    maxDownloadBytes: 1000,
    deviceCacheTtlSeconds: 60,
    locations: {},
    ...over,
  }) as Config;

describe("createLazyTransport", () => {
  it("resolves no trust until the first request", async () => {
    // The point of the whole module: createServer must not open a socket, or an
    // unreachable console becomes a server that never finishes starting and
    // reaches the client as a bare "Connection closed".
    resolveTrust.mockReset();
    createLazyTransport({ config: config() });
    expect(resolveTrust).not.toHaveBeenCalled();
  });

  it("resolves trust once and reuses it across concurrent first calls", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    resolveTrust.mockReset().mockResolvedValue({ mode: "insecure" });
    createTransport.mockReset().mockReturnValue({ fetch: inner, close: vi.fn() });

    const transport = createLazyTransport({ config: config() });
    await Promise.all([
      transport.fetch("https://192.168.1.1/a"),
      transport.fetch("https://192.168.1.1/b"),
    ]);

    // Two captures would race to write the same trust file.
    expect(resolveTrust).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("keys the pin on the configured host and port", async () => {
    resolveTrust.mockReset().mockResolvedValue({ mode: "insecure" });
    createTransport
      .mockReset()
      .mockReturnValue({ fetch: async () => new Response("{}"), close: vi.fn() });

    const transport = createLazyTransport({ config: config({ baseUrl: "https://udm.lan:8443" }) });
    await transport.fetch("https://udm.lan:8443/a");

    expect(resolveTrust).toHaveBeenCalledWith(
      expect.objectContaining({ host: "udm.lan", port: 8443, insecure: false }),
    );
  });

  it("passes a configured fingerprint through, and asks for insecure when verification is off", async () => {
    resolveTrust.mockReset().mockResolvedValue({ mode: "insecure" });
    createTransport
      .mockReset()
      .mockReturnValue({ fetch: async () => new Response("{}"), close: vi.fn() });

    const transport = createLazyTransport({
      config: config({ verifyTls: false, fingerprint: "AB:CD" }),
    });
    await transport.fetch("https://192.168.1.1/a");

    expect(resolveTrust).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFingerprint: "AB:CD", insecure: true }),
    );
  });

  it("uses the platform fetch in cloud mode, where the certificate is real", async () => {
    resolveTrust.mockReset();
    const transport = createLazyTransport({
      config: config({ mode: "cloud", apiKey: "k", consoleId: "c" }),
    });
    expect(transport.fetch).toBe(fetch);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(resolveTrust).not.toHaveBeenCalled();
  });

  it("closes nothing when no request was ever made", async () => {
    resolveTrust.mockReset();
    const transport = createLazyTransport({ config: config() });
    await expect(transport.close()).resolves.toBeUndefined();
    expect(resolveTrust).not.toHaveBeenCalled();
  });

  it("does not let a failed certificate capture turn shutdown into a second error", async () => {
    resolveTrust.mockReset().mockRejectedValue(new Error("console unreachable"));
    createTransport.mockReset();

    const transport = createLazyTransport({ config: config() });
    await expect(transport.fetch("https://192.168.1.1/a")).rejects.toThrow(/console unreachable/);
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
