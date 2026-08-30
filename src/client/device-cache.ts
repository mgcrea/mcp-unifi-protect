import { buildCameraIndex, type CameraFacts, type CameraIndex } from "./detection.js";
import type { ProtectClient } from "./protect.js";
import type { NameIndex } from "./shape.js";

export type DeviceCacheOptions = {
  client: ProtectClient;
  ttlSeconds: number;
  now?: () => number;
};

/**
 * A short-lived index of the cameras, used to resolve the `camera` reference on
 * every event into something readable, and to explain why a detection search
 * could not have matched.
 *
 * It is cached because event search is the hot path and every result set needs
 * the same index: fetching the camera list once per search rather than once per
 * event is the difference between one extra request and none. The TTL is short
 * because a renamed or newly adopted camera should appear without a restart,
 * and a stale name is only ever cosmetic — the id travels alongside it.
 *
 * Names and detection facts come from ONE fetch. They were two calls until the
 * gate cross-check needed both on the same path, and a second round-trip per
 * search to re-read the list we already had is pure waste.
 */
export type DeviceCache = {
  /** id → display name, for resolving event references. */
  cameras(): Promise<NameIndex>;
  /** id → everything that decides whether a detection could occur. */
  facts(): Promise<CameraIndex>;
  /**
   * The console's IANA time zone, or undefined if it cannot be read.
   *
   * Needed to interpret "1am" as the person asking meant it. Cached far longer
   * than the camera list: a console's zone changes when someone moves house.
   */
  timeZone(): Promise<string | undefined>;
  invalidate(): void;
};

const EMPTY: CameraIndex = new Map<string, CameraFacts>();

export const createDeviceCache = (opts: DeviceCacheOptions): DeviceCache => {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlSeconds * 1000;
  let cached: { index: CameraIndex; expiresAt: number } | undefined;
  let zone: { value: string | undefined; expiresAt: number } | undefined;
  // Concurrent event searches would otherwise each fetch the camera list.
  let inflight: Promise<CameraIndex> | undefined;

  const fetchIndex = async (): Promise<CameraIndex> => {
    const cameras = await opts.client.get<unknown>("cameras");
    const index = buildCameraIndex(cameras);
    cached = { index, expiresAt: now() + ttlMs };
    return index;
  };

  const load = async (): Promise<CameraIndex> => {
    if (cached && now() < cached.expiresAt) return cached.index;
    if (!inflight) {
      inflight = fetchIndex().finally(() => {
        inflight = undefined;
      });
    }
    try {
      return await inflight;
    } catch {
      // Name resolution and the gate cross-check are both niceties, not the
      // answer. If the camera list is unreachable, events still come back with
      // their ids rather than the whole search failing over a lookup.
      return EMPTY;
    }
  };

  return {
    async timeZone(): Promise<string | undefined> {
      if (zone && now() < zone.expiresAt) return zone.value;
      let value: string | undefined;
      try {
        const nvr = await opts.client.get<{ timezone?: unknown }>("nvr");
        value = typeof nvr?.timezone === "string" && nvr.timezone ? nvr.timezone : undefined;
      } catch {
        // A zone lookup must never fail a search. Without it, naive local times
        // are rejected with a message saying so rather than guessed at.
        value = undefined;
      }
      zone = { value, expiresAt: now() + Math.max(ttlMs, 3_600_000) };
      return value;
    },

    async cameras(): Promise<NameIndex> {
      const index = await load();
      return new Map([...index].map(([id, facts]) => [id, facts.name]));
    },
    facts: load,
    invalidate(): void {
      cached = undefined;
      zone = undefined;
    },
  };
};
