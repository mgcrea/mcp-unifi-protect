import { describe, expect, it } from "vitest";

import { isConfigured, loadConfig, normalizeBaseUrl, setupInstructions } from "../src/config.js";
import { toEpochMs } from "../src/tools/util.js";

const NO_FILE = "/nonexistent/unifi-protect-config.json";

describe("normalizeBaseUrl", () => {
  it("assumes https for a bare host", () => {
    expect(normalizeBaseUrl("192.168.1.1")).toBe("https://192.168.1.1");
  });

  it("preserves an explicit port", () => {
    // Consoles are commonly reached on a non-443 port, and the normalizers in
    // mcp-keycloak and mcp-shopify both drop it.
    expect(normalizeBaseUrl("10.0.0.1:8443")).toBe("https://10.0.0.1:8443");
    expect(normalizeBaseUrl("https://udm.lan:8443/protect")).toBe("https://udm.lan:8443");
  });

  it("discards any pasted path", () => {
    expect(normalizeBaseUrl("https://udm.lan/protect/dashboard")).toBe("https://udm.lan");
    expect(normalizeBaseUrl("https://udm.lan/")).toBe("https://udm.lan");
  });

  it("forces https, so the session cookie never crosses cleartext", () => {
    expect(normalizeBaseUrl("http://192.168.1.1")).toBe("https://192.168.1.1");
  });
});

describe("loadConfig", () => {
  it("never throws when nothing is configured", () => {
    // An MCP server that exits at startup shows in the client as a bare
    // "Connection closed" with stderr swallowed.
    const config = loadConfig({}, NO_FILE);
    expect(isConfigured(config)).toBe(false);
    expect(config.allowWrites).toBe(false);
    expect(config.verifyTls).toBe(false);
  });

  it("defaults writes off and TLS verification off", () => {
    const config = loadConfig(
      { UNIFI_PROTECT_HOST: "1.2.3.4", UNIFI_PROTECT_USERNAME: "u", UNIFI_PROTECT_PASSWORD: "p" },
      NO_FILE,
    );
    expect(config.allowWrites).toBe(false);
    expect(config.verifyTls).toBe(false);
    expect(isConfigured(config)).toBe(true);
  });

  it("reads the boolean spellings people actually type", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      expect(loadConfig({ UNIFI_PROTECT_ALLOW_WRITES: value }, NO_FILE).allowWrites).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(loadConfig({ UNIFI_PROTECT_ALLOW_WRITES: value }, NO_FILE).allowWrites).toBe(false);
    }
  });

  it("treats an empty env var as unset rather than empty", () => {
    expect(loadConfig({ UNIFI_PROTECT_HOST: "   " }, NO_FILE).baseUrl).toBeUndefined();
  });

  it("flags a half-configured install rather than failing later", () => {
    expect(() => loadConfig({ UNIFI_PROTECT_HOST: "1.2.3.4" }, NO_FILE)).toThrow(
      /UNIFI_PROTECT_USERNAME/,
    );
  });

  it("names the local-account trap in the setup instructions", () => {
    const text = setupInstructions(loadConfig({}, NO_FILE)).join(" ");
    expect(text).toMatch(/Local Access Only/);
    expect(text).toMatch(/self-signed/);
  });
});

describe("toEpochMs", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");

  it("accepts ISO 8601", () => {
    expect(toEpochMs("2026-08-29T10:00:00.000Z", now)).toBe(Date.parse("2026-08-29T10:00:00Z"));
  });

  it("accepts relative expressions", () => {
    expect(toEpochMs("2h ago", now)).toBe(now - 7_200_000);
    expect(toEpochMs("30m", now)).toBe(now - 1_800_000);
    expect(toEpochMs("7d", now)).toBe(now - 604_800_000);
    expect(toEpochMs("now", now)).toBe(now);
  });

  it("catches Unix seconds rather than silently querying 1970", () => {
    // The most expensive failure this server has: a seconds value is not
    // rejected by the console, it just returns an empty list, which reads as
    // "nothing happened last night".
    expect(() => toEpochMs("1756500000", now)).toThrow(/SECONDS/);
    expect(() => toEpochMs("1756500000", now)).toThrow(/1756500000000/);
  });

  it("passes milliseconds through", () => {
    expect(toEpochMs("1756500000000", now)).toBe(1_756_500_000_000);
    expect(toEpochMs(1_756_500_000_000, now)).toBe(1_756_500_000_000);
  });

  it("explains an unparseable value", () => {
    expect(() => toEpochMs("last tuesday", now)).toThrow(/ISO 8601/);
  });
});
