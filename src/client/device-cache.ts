import type { ProtectClient } from "./protect.js";
import { buildNameIndex, type NameIndex } from "./shape.js";

export type DeviceCacheOptions = {
  client: ProtectClient;
  ttlSeconds: number;
  now?: () => number;
};

/**
 * A short-lived camera id→name index, used to resolve the `camera` reference on
 * every event into something readable.
 *
 * It is cached because event search is the hot path and every result set needs
 * the same index: fetching the camera list once per search rather than once per
 * event is the difference between one extra request and none. The TTL is short
 * because a renamed or newly adopted camera should appear without a restart,
 * and a stale name is only ever cosmetic — the id travels alongside it.
 */
export type DeviceCache = {
  cameras(): Promise<NameIndex>;
  invalidate(): void;
};

export const createDeviceCache = (opts: DeviceCacheOptions): DeviceCache => {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlSeconds * 1000;
  let cached: { index: NameIndex; expiresAt: number } | undefined;
  // Concurrent event searches would otherwise each fetch the camera list.
  let inflight: Promise<NameIndex> | undefined;

  const fetchIndex = async (): Promise<NameIndex> => {
    const cameras = await opts.client.get<unknown>("cameras");
    const index = buildNameIndex(cameras);
    cached = { index, expiresAt: now() + ttlMs };
    return index;
  };

  return {
    async cameras(): Promise<NameIndex> {
      if (cached && now() < cached.expiresAt) return cached.index;
      if (!inflight) {
        inflight = fetchIndex().finally(() => {
          inflight = undefined;
        });
      }
      try {
        return await inflight;
      } catch {
        // Name resolution is a nicety, not the answer. If the camera list is
        // unreachable, events still come back with their ids rather than the
        // whole search failing over a cosmetic lookup.
        return new Map<string, string>();
      }
    },
    invalidate(): void {
      cached = undefined;
    },
  };
};
