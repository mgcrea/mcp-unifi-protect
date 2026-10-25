import type { ProtectClient } from "@mgcrea/unifi-protect";
import { describe, expect, it, vi } from "vitest";

import { createDeviceCache } from "#/client/device-cache";

const clientWith = (get: (path: string) => Promise<unknown>): ProtectClient =>
  ({ get: vi.fn(get) }) as unknown as ProtectClient;

describe("createDeviceCache", () => {
  it("does not remember a failed time zone lookup", async () => {
    // A lookup that failed because the session needed a 2FA code, or the
    // console was briefly away, must not leave "1am" refused for the next hour
    // once it is back. The camera list beside it never caches a failure.
    let reachable = false;
    const client = clientWith(async (path) => {
      if (!reachable) throw new Error("console unreachable");
      return path === "nvr" ? { timezone: "Europe/Paris" } : [];
    });
    const cache = createDeviceCache({ client, ttlSeconds: 60 });

    await expect(cache.timeZone()).resolves.toBeUndefined();
    reachable = true;
    await expect(cache.timeZone()).resolves.toBe("Europe/Paris");
  });

  it("keeps a zone it did read for at least an hour", async () => {
    let now = 0;
    const client = clientWith(async () => ({ timezone: "Europe/Paris" }));
    const cache = createDeviceCache({ client, ttlSeconds: 60, now: () => now });

    await cache.timeZone();
    now = 3_599_000;
    await cache.timeZone();
    expect(client.get).toHaveBeenCalledTimes(1);
  });
});
