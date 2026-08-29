import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  isoTime,
  summarizeBootstrap,
  summarizeCamera,
  summarizeEvent,
  summarizeNvr,
  summarizeSensor,
} from "../src/client/shape.js";

describe("isoTime", () => {
  it("renders a millisecond epoch as ISO 8601", () => {
    expect(isoTime(1_756_500_000_000)).toBe("2025-08-29T20:40:00.000Z");
  });

  it("returns undefined for absent or zero timestamps", () => {
    expect(isoTime(undefined)).toBeUndefined();
    expect(isoTime(0)).toBeUndefined();
    expect(isoTime("2026-01-01")).toBeUndefined();
  });
});

describe("summarizeCamera", () => {
  const raw = {
    id: "cam1",
    name: "Front Door",
    type: "UVC G4 Doorbell",
    mac: "AABBCCDDEEFF",
    host: "192.168.1.50",
    isConnected: true,
    state: "CONNECTED",
    isRecording: true,
    firmwareVersion: "4.70.55",
    lastSeen: 1_756_500_000_000,
    recordingSettings: { mode: "detections", retentionDurationMs: null, prePaddingSecs: 2 },
    smartDetectSettings: { objectTypes: ["person", "package"], audioTypes: [] },
    featureFlags: { hasPackageCamera: true, hasSmartDetect: true, canOpticalZoom: false },
    // The bulk that must not survive.
    channels: [{ id: 0, bitrate: 3_000_000 }, { id: 1 }, { id: 2 }],
    stats: { rxBytes: 999, storage: { used: 1 } },
    motionZones: [{ points: [[0, 0]] }],
    privacyZones: [],
    ispSettings: { brightness: 50 },
  };

  it("keeps the fields someone asks about", () => {
    expect(summarizeCamera(raw)).toEqual({
      id: "cam1",
      name: "Front Door",
      type: "UVC G4 Doorbell",
      mac: "AABBCCDDEEFF",
      host: "192.168.1.50",
      isConnected: true,
      state: "CONNECTED",
      isRecording: true,
      recordingMode: "detections",
      hasPtz: false,
      hasPackageCamera: true,
      hasSmartDetect: true,
      smartDetectTypes: ["person", "package"],
      firmwareVersion: "4.70.55",
      isUpdating: undefined,
      lastSeen: "2025-08-29T20:40:00.000Z",
    });
  });

  it("drops the console's bulk", () => {
    const shaped = summarizeCamera(raw);
    for (const dropped of [
      "channels",
      "stats",
      "motionZones",
      "privacyZones",
      "ispSettings",
      "featureFlags",
    ]) {
      expect(shaped, dropped).not.toHaveProperty(dropped);
    }
  });

  it("survives a camera missing every nested settings block", () => {
    expect(() => summarizeCamera({ id: "x", name: "y" })).not.toThrow();
    expect(summarizeCamera({ id: "x", name: "y" }).smartDetectTypes).toEqual([]);
  });
});

describe("summarizeEvent", () => {
  const cameras = buildNameIndex([
    { id: "cam1", name: "Front Door" },
    { id: "cam2", name: "Driveway" },
  ]);

  it("resolves the camera id to a name, keeping the id", () => {
    // This is the join the model would otherwise have to perform against a
    // separate camera list, and could silently get wrong.
    const shaped = summarizeEvent(
      {
        id: "evt1",
        type: "smartDetectZone",
        start: 1_756_500_000_000,
        end: 1_756_500_010_000,
        camera: "cam1",
        smartDetectTypes: ["person"],
        score: 92,
        thumbnail: "e-thumb-1",
      },
      cameras,
    );
    expect(shaped).toMatchObject({
      id: "evt1",
      cameraId: "cam1",
      camera: "Front Door",
      smartDetectTypes: ["person"],
      score: 92,
      hasThumbnail: true,
      start: "2025-08-29T20:40:00.000Z",
    });
  });

  it("keeps the id when the camera is not in the index", () => {
    const shaped = summarizeEvent({ id: "e", camera: "unknown" }, cameras);
    expect(shaped.cameraId).toBe("unknown");
    expect(shaped).not.toHaveProperty("camera");
  });

  it("omits empty optional fields rather than emitting nulls", () => {
    const shaped = summarizeEvent({ id: "e", type: "motion", smartDetectTypes: [] }, cameras);
    expect(shaped).not.toHaveProperty("smartDetectTypes");
    expect(shaped).not.toHaveProperty("score");
    expect(shaped).not.toHaveProperty("hasThumbnail");
  });

  it("reports a thumbnail as a flag, never as the console's own id", () => {
    // The console's `thumbnail` field is `e-<eventId>`, which belongs to the
    // `thumbnails/<id>` endpoint, NOT the `events/<eventId>/thumbnail` one this
    // server uses. Handing that value out invites passing it to the wrong
    // place, which 404s — verified against a live console on Protect 7.2.105.
    const shaped = summarizeEvent({ id: "evt9", thumbnail: "e-evt9" }, cameras);
    expect(shaped.hasThumbnail).toBe(true);
    expect(JSON.stringify(shaped)).not.toContain("e-evt9");
  });

  it("surfaces a licence plate out of the metadata block", () => {
    const shaped = summarizeEvent(
      { id: "e", camera: "cam2", metadata: { licensePlate: { name: "AB-123-CD" } } },
      cameras,
    );
    expect(shaped.licensePlate).toBe("AB-123-CD");
  });
});

describe("summarizeSensor", () => {
  it("lifts readings out of the per-metric stats blocks", () => {
    // The history arrays beside each value are far larger than the reading.
    const shaped = summarizeSensor({
      id: "s1",
      name: "Garage",
      isConnected: true,
      batteryStatus: { percentage: 87, isLow: false },
      stats: {
        temperature: { value: 21.5, history: [1, 2, 3] },
        humidity: { value: 44, history: [4, 5] },
        light: { value: 120, history: [] },
      },
    });
    expect(shaped).toMatchObject({
      temperature: 21.5,
      humidity: 44,
      light: 120,
      batteryStatus: 87,
    });
    expect(shaped).not.toHaveProperty("stats");
  });
});

describe("summarizeBootstrap", () => {
  it("reduces the whole console state to counts plus the NVR summary", () => {
    const shaped = summarizeBootstrap({
      nvr: { id: "nvr", name: "Console", version: "6.2.83", storageInfo: {}, systemInfo: {} },
      cameras: [{ id: "a" }, { id: "b" }],
      lights: [{ id: "l" }],
      sensors: [],
      users: [{ id: "u" }],
      liveviews: [{ id: "lv" }],
      lastUpdateId: "abc",
    });
    expect(shaped.devices).toMatchObject({ cameras: 2, lights: 1, sensors: 0 });
    expect(shaped.users).toBe(1);
    expect((shaped.nvr as Record<string, unknown>).version).toBe("6.2.83");
    // The raw arrays must never survive — this is the largest payload the API has.
    expect(shaped).not.toHaveProperty("cameras");
  });
});

describe("summarizeNvr storage", () => {
  // Protect moved storage between releases. Reading only one layout returns an
  // empty `storage: {}` on the other — which is exactly how this was found, on
  // a live console running 7.2.105.
  it("reads the Protect 7.x layout (systemInfo.storage + storageStats)", () => {
    const shaped = summarizeNvr({
      id: "n",
      name: "UNVR",
      version: "7.2.105",
      hardDriveState: "ok",
      isRecycling: true,
      upSince: Date.now() - 60_000,
      systemInfo: {
        storage: {
          size: 3_928_324_915_200,
          used: 3_679_084_625_920,
          available: 249_240_289_280,
          type: "raid",
          capability: "ok",
        },
        ustorage: {
          raid: "raid5",
          disks: [
            { slot: 1, healthy: "good" },
            { slot: 2, healthy: "good" },
            { slot: 3, healthy: "bad" },
            { slot: 4, healthy: "good" },
          ],
        },
        memory: { available: 1_964_868, total: 4_040_180 },
        cpu: { averageLoad: 11.2, temperature: 72 },
      },
      storageStats: { utilization: 99.60844635235273 },
    });
    const storage = shaped.storage as Record<string, unknown>;
    expect(storage.totalBytes).toBe(3_928_324_915_200);
    expect(storage.usedBytes).toBe(3_679_084_625_920);
    expect(storage.utilizationPercent).toBe(99.6);
    expect(storage.raid).toBe("raid5");
    expect(storage.disks).toBe(4);
    expect(storage.disksUnhealthy).toBe(1);
    // A near-full recycling NVR is working as designed; say so rather than
    // letting it be reported as a fault.
    expect(storage.isRecycling).toBe(true);
    expect(String(storage.note)).toMatch(/normal/i);
    expect(shaped.cpu).toEqual({ load: 11.2, temperature: 72 });
    expect(shaped.uptimeSeconds).toBeGreaterThanOrEqual(59);
  });

  it("still reads the Protect 6.x layout (storageInfo)", () => {
    const shaped = summarizeNvr({
      id: "n",
      name: "Console",
      version: "6.2.83",
      storageInfo: { totalSize: 4_000_000_000_000, totalSpaceUsed: 1_200_000_000_000 },
      uptime: 123_456_000,
    });
    const storage = shaped.storage as Record<string, unknown>;
    expect(storage.totalBytes).toBe(4_000_000_000_000);
    expect(storage.usedBytes).toBe(1_200_000_000_000);
    // Derived, since the 6.x payload gives no `available`.
    expect(storage.availableBytes).toBe(2_800_000_000_000);
    expect(shaped.uptimeSeconds).toBe(123_456);
  });

  it("does not invent fields when the console reports no storage at all", () => {
    expect(summarizeNvr({ id: "n", name: "x" }).storage).toEqual({});
  });
});
