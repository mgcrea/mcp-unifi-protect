import { describe, expect, it } from "vitest";

import {
  consoleOrigin,
  isConfigured,
  loadConfig,
  normalizeBaseUrl,
  setupInstructions,
} from "../src/config.js";
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
    expect(config.verifyTls).toBe(true);
  });

  it("defaults writes off and TLS verification ON", () => {
    const config = loadConfig(
      { UNIFI_PROTECT_HOST: "1.2.3.4", UNIFI_PROTECT_USERNAME: "u", UNIFI_PROTECT_PASSWORD: "p" },
      NO_FILE,
    );
    expect(config.allowWrites).toBe(false);
    // Verification is on by default and turning it off is an explicit act. A
    // console addressed by IP cannot pass it — the certificate has no IP SAN —
    // so an IP host is exactly the case that must fail loudly rather than
    // silently downgrade.
    expect(config.verifyTls).toBe(true);
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

  it("reports a half-configured install as an issue, and never throws", () => {
    // A throw from loadConfig exits the process, which the client shows as a
    // bare "Connection closed" with stderr swallowed — the one failure this
    // server exists to avoid. Incomplete config must be data, not an exception.
    const c = loadConfig({ UNIFI_PROTECT_HOST: "1.2.3.4" }, NO_FILE);
    expect(c.issues.join(" ")).toMatch(/UNIFI_PROTECT_USERNAME/);
    expect(isConfigured(c)).toBe(false);
  });

  it("never throws for any partial combination of credentials", () => {
    const partials: NodeJS.ProcessEnv[] = [
      { UNIFI_PROTECT_HOST: "1.2.3.4" },
      { UNIFI_PROTECT_USERNAME: "u" },
      { UNIFI_PROTECT_PASSWORD: "p" },
      { UNIFI_PROTECT_HOST: "1.2.3.4", UNIFI_PROTECT_USERNAME: "u" },
      { UNIFI_PROTECT_API_KEY: "k" },
      { UNIFI_PROTECT_CONSOLE_ID: "c" },
      { UNIFI_PROTECT_MODE: "cloud" },
      { UNIFI_PROTECT_MODE: "cloud", UNIFI_PROTECT_API_KEY: "k" },
      { UNIFI_PROTECT_MODE: "nonsense", UNIFI_PROTECT_HOST: "1.2.3.4" },
    ];
    for (const env of partials) {
      expect(() => loadConfig(env, NO_FILE), JSON.stringify(env)).not.toThrow();
    }
  });

  it("names the API-key trap when a key is set in local mode", () => {
    // Verified on a UNVR running Protect 7.2.105: a console-issued key answers
    // 200 on the official Integration API and 401 on every private path.
    const c = loadConfig({ UNIFI_PROTECT_HOST: "1.2.3.4", UNIFI_PROTECT_API_KEY: "k" }, NO_FILE);
    expect(c.mode).toBe("local");
    expect(c.issues.join(" ")).toMatch(/local mode cannot use it/);
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

describe("modes", () => {
  const NONE = "/nonexistent/unifi-protect-config.json";

  it("defaults to local", () => {
    expect(loadConfig({}, NONE).mode).toBe("local");
  });

  it("infers cloud from an api key plus a console id", () => {
    // Nobody sets both of those for a local install, so requiring an explicit
    // UNIFI_PROTECT_MODE would only be a way to get it wrong.
    const c = loadConfig({ UNIFI_PROTECT_API_KEY: "k", UNIFI_PROTECT_CONSOLE_ID: "abc:1" }, NONE);
    expect(c.mode).toBe("cloud");
    expect(c.modeSource).toBe("inferred");
    expect(isConfigured(c)).toBe(true);
  });

  it("accepts the synonyms people actually type", () => {
    for (const v of ["cloud", "remote", "site-manager", "CLOUD"]) {
      expect(loadConfig({ UNIFI_PROTECT_MODE: v }, NONE).mode, v).toBe("cloud");
    }
    for (const v of ["local", "console", "unifios", "unifi-os", "lan"]) {
      expect(loadConfig({ UNIFI_PROTECT_MODE: v }, NONE).mode, v).toBe("local");
    }
  });

  it("does not exit on an unrecognised mode", () => {
    // Exiting over a typo is the exact failure this server exists to avoid —
    // the client would show only "Connection closed".
    const c = loadConfig({ UNIFI_PROTECT_MODE: "nonsense" }, NONE);
    expect(c.mode).toBe("local");
    expect(c.modeSource).toBe("invalid");
    expect(setupInstructions(c).join(" ")).toMatch(/not recognised/i);
  });

  it("builds the connector origin in cloud mode", () => {
    const c = loadConfig(
      { UNIFI_PROTECT_MODE: "cloud", UNIFI_PROTECT_API_KEY: "k", UNIFI_PROTECT_CONSOLE_ID: "C1:2" },
      NONE,
    );
    expect(consoleOrigin(c)).toBe("https://api.ui.com/v1/connector/consoles/C1:2");
  });

  it("uses the console origin in local mode", () => {
    const c = loadConfig(
      {
        UNIFI_PROTECT_HOST: "10.0.0.9:8443",
        UNIFI_PROTECT_USERNAME: "u",
        UNIFI_PROTECT_PASSWORD: "p",
      },
      NONE,
    );
    expect(consoleOrigin(c)).toBe("https://10.0.0.9:8443");
  });

  it("cloud mode needs no local account, and says so when half-set", () => {
    expect(isConfigured(loadConfig({ UNIFI_PROTECT_MODE: "cloud" }, NONE))).toBe(false);
    expect(
      loadConfig({ UNIFI_PROTECT_MODE: "cloud", UNIFI_PROTECT_API_KEY: "k" }, NONE).issues.join(
        " ",
      ),
    ).toMatch(/UNIFI_PROTECT_CONSOLE_ID/);
    expect(
      loadConfig({ UNIFI_PROTECT_MODE: "cloud", UNIFI_PROTECT_CONSOLE_ID: "c" }, NONE).issues.join(
        " ",
      ),
    ).toMatch(/UNIFI_PROTECT_API_KEY/);
  });

  it("local setup guidance warns that an API key will not work", () => {
    // The trap: a console-issued key IS accepted by the official Integration
    // API, so it looks valid, while every private-API call answers 401.
    // Verified against a UNVR on Protect 7.2.105.
    const text = setupInstructions(loadConfig({}, NONE)).join(" ");
    expect(text).toMatch(/API key will NOT work in local mode/);
    expect(text).toMatch(/username and password is the only local option/i);
  });

  it("cloud setup guidance names the 403 org trap", () => {
    // Verified against a live account: a key valid for /v1/hosts still gets
    // 403 "user cannot access host in the organization" for a console outside
    // its org, which reads nothing like a credentials problem.
    const text = setupInstructions(loadConfig({ UNIFI_PROTECT_MODE: "cloud" }, NONE)).join(" ");
    expect(text).toMatch(/organization/i);
    expect(text).toMatch(/api\.ui\.com\/v1\/hosts/);
  });
});
