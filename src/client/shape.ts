// UniFi Protect's private API answers with the console's internal representation,
// which is built for its own web app and not for a context window. One camera in
// `bootstrap` runs to roughly 8-15 KB of JSON once `channels[]` (three encoder
// profiles, ~20 fields each), `stats`, `featureFlags` (around 60 booleans),
// `ispSettings`, `osdSettings`, `motionZones`, `smartDetectZones`, `privacyZones`
// and `lenses` are counted. A ten-camera system is well over 100 KB from what
// looks like a one-line "list my cameras".
//
// So list tools return an allowlist of the fields someone actually asks about,
// and `get_*` tools return the full object — that is the point of a get.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Apply a summarizer across an array, passing non-arrays through untouched. */
export const summarizeEach = <T>(value: unknown, fn: (item: Rec) => T): unknown =>
  Array.isArray(value) ? value.filter(isRecord).map(fn) : value;

/**
 * Protect timestamps are milliseconds since the Unix epoch. Rendering them as
 * ISO 8601 costs a few characters and saves the model from having to reason
 * about a bare 13-digit integer — which it does get wrong, usually by reading
 * it as seconds and landing in 1970.
 */
export const isoTime = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
};

/**
 * Render an instant as wall-clock time in the console's zone.
 *
 * Every timestamp this server returns is ISO 8601 in UTC, which is unambiguous
 * but is not the time anyone asked about. "Between 1am and 6am" is a question
 * about the console's local clock, so the local rendering travels alongside.
 */
export const localTime = (ms: number, timeZone: string | undefined): string | undefined => {
  if (!timeZone || !Number.isFinite(ms)) return undefined;
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  } catch {
    // An unknown zone must not take down a search.
    return undefined;
  }
};

/** An index from device id to display name, used to resolve event references. */
export type NameIndex = ReadonlyMap<string, string>;

export const buildNameIndex = (devices: unknown): NameIndex => {
  const index = new Map<string, string>();
  if (!Array.isArray(devices)) return index;
  for (const device of devices) {
    if (!isRecord(device)) continue;
    const id = str(device.id);
    const name = str(device.name);
    if (id && name) index.set(id, name);
  }
  return index;
};

export const summarizeCamera = (camera: Rec): Rec => {
  const flags = isRecord(camera.featureFlags) ? camera.featureFlags : {};
  const recording = isRecord(camera.recordingSettings) ? camera.recordingSettings : {};
  const smart = isRecord(camera.smartDetectSettings) ? camera.smartDetectSettings : {};
  return {
    id: camera.id,
    name: camera.name,
    type: camera.type,
    mac: camera.mac,
    host: camera.host,
    isConnected: camera.isConnected,
    state: camera.state,
    isRecording: camera.isRecording,
    recordingMode: recording.mode,
    // What the camera can actually do, drawn out of ~60 feature flags. These
    // three are the ones that decide whether another tool call is even valid:
    // a PTZ tool against a fixed camera is a guaranteed error.
    hasPtz: flags.canOpticalZoom ?? flags.hasPtz ?? false,
    hasPackageCamera: flags.hasPackageCamera ?? false,
    hasSmartDetect: flags.hasSmartDetect ?? false,
    smartDetectTypes: smart.objectTypes ?? [],
    firmwareVersion: camera.firmwareVersion,
    isUpdating: camera.isUpdating,
    lastSeen: isoTime(camera.lastSeen),
  };
};

/**
 * Events reference their camera by id. Resolving that to a name server-side is
 * the single most useful thing this layer does: it removes a join the model
 * would otherwise have to perform against a separate camera list, and get
 * silently wrong. The id is kept too, since the write and snapshot tools need it.
 */
export const summarizeEvent = (event: Rec, cameras?: NameIndex, timeZone?: string): Rec => {
  const cameraId = str(event.camera);
  const metadata = isRecord(event.metadata) ? event.metadata : undefined;
  const plate =
    metadata && isRecord(metadata.licensePlate) ? str(metadata.licensePlate.name) : undefined;

  return {
    id: event.id,
    type: event.type,
    start: isoTime(event.start),
    end: isoTime(event.end),
    // The local clock alongside UTC. "Was anyone there at 2am" is a question
    // about the console's wall clock, and making the reader do the offset
    // arithmetic is where an hour goes missing.
    ...(timeZone && typeof event.start === "number"
      ? { localStart: localTime(event.start, timeZone) }
      : {}),
    ...(cameraId ? { cameraId } : {}),
    ...(cameraId && cameras?.get(cameraId) ? { camera: cameras.get(cameraId) } : {}),
    ...(Array.isArray(event.smartDetectTypes) && event.smartDetectTypes.length > 0
      ? { smartDetectTypes: event.smartDetectTypes }
      : {}),
    // Only present on smart detections, and the reason someone searched.
    ...(plate ? { licensePlate: plate } : {}),
    ...(typeof event.score === "number" ? { score: event.score } : {}),
    // Whether a still frame exists, so the model knows
    // unifi_protect_get_event_thumbnail is worth calling. Deliberately a flag
    // and not an id: the console's own `thumbnail` field is `e-<eventId>`,
    // which belongs to a DIFFERENT endpoint (`thumbnails/<id>`) than the one
    // this server uses (`events/<eventId>/thumbnail`). Handing that value out
    // invites passing it to the wrong place, which 404s — as it did here.
    ...(str(event.thumbnail) ? { hasThumbnail: true } : {}),
  };
};

export const summarizeLight = (light: Rec): Rec => {
  const settings = isRecord(light.lightDeviceSettings) ? light.lightDeviceSettings : {};
  return {
    id: light.id,
    name: light.name,
    isConnected: light.isConnected,
    isLightOn: light.isLightOn,
    isPirMotionDetected: light.isPirMotionDetected,
    ledLevel: settings.ledLevel,
    isIndicatorEnabled: settings.isIndicatorEnabled,
    firmwareVersion: light.firmwareVersion,
    lastSeen: isoTime(light.lastSeen),
  };
};

export const summarizeSensor = (sensor: Rec): Rec => {
  const stats = isRecord(sensor.stats) ? sensor.stats : {};
  const reading = (key: string): unknown => {
    const block = stats[key];
    return isRecord(block) ? block.value : undefined;
  };
  return {
    id: sensor.id,
    name: sensor.name,
    type: sensor.type,
    isConnected: sensor.isConnected,
    mountType: sensor.mountType,
    batteryStatus: isRecord(sensor.batteryStatus) ? sensor.batteryStatus.percentage : undefined,
    isOpened: sensor.isOpened,
    isMotionDetected: sensor.isMotionDetected,
    // The readings are the point of a sensor, but they sit one level down
    // inside `stats.<metric>.value` alongside per-metric history arrays that
    // are far larger than the reading itself.
    temperature: reading("temperature"),
    humidity: reading("humidity"),
    light: reading("light"),
    firmwareVersion: sensor.firmwareVersion,
    lastSeen: isoTime(sensor.lastSeen),
  };
};

export const summarizeViewer = (viewer: Rec): Rec => ({
  id: viewer.id,
  name: viewer.name,
  isConnected: viewer.isConnected,
  liveview: viewer.liveview,
  streamLimit: viewer.streamLimit,
  firmwareVersion: viewer.firmwareVersion,
  lastSeen: isoTime(viewer.lastSeen),
});

export const summarizeChime = (chime: Rec): Rec => ({
  id: chime.id,
  name: chime.name,
  isConnected: chime.isConnected,
  volume: chime.volume,
  cameraIds: chime.cameraIds,
  firmwareVersion: chime.firmwareVersion,
  lastSeen: isoTime(chime.lastSeen),
});

export const summarizeLiveview = (liveview: Rec): Rec => ({
  id: liveview.id,
  name: liveview.name,
  isDefault: liveview.isDefault,
  owner: liveview.owner,
  // `slots` holds the full camera layout; the count is what someone asks about.
  slotCount: Array.isArray(liveview.slots) ? liveview.slots.length : undefined,
});

export const summarizeUser = (user: Rec): Rec => ({
  id: user.id,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  role: user.role,
  isOwner: user.isOwner,
  lastLoginTime: isoTime(user.lastLoginTime),
});

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const rec = (value: unknown): Rec | undefined => (isRecord(value) ? value : undefined);

/**
 * Storage moved between Protect releases, so both layouts are read.
 *
 * Protect 6.x exposed `nvr.storageInfo` with `totalSize` / `totalSpaceUsed` and a
 * `devices[]` array carrying full SMART tables. By 7.2 that key is gone entirely:
 * the same numbers live under `nvr.systemInfo.storage` as `size` / `used` /
 * `available`, the per-disk detail moved to `systemInfo.ustorage.disks`, and a
 * separate `nvr.storageStats` carries utilization. Reading only one shape gives
 * an empty `storage: {}` on the other, which is how this was found.
 */
const summarizeStorage = (nvr: Rec): Rec => {
  const system = rec(nvr.systemInfo);
  const modern = rec(system?.storage);
  const legacy = rec(nvr.storageInfo);
  const stats = rec(nvr.storageStats);
  const ustorage = rec(system?.ustorage);
  const disks = Array.isArray(ustorage?.disks) ? ustorage.disks.filter(isRecord) : undefined;

  const total = num(modern?.size) ?? num(legacy?.totalSize);
  const used = num(modern?.used) ?? num(legacy?.totalSpaceUsed);
  const available =
    num(modern?.available) ??
    (total !== undefined && used !== undefined ? total - used : undefined);

  return {
    ...(total !== undefined ? { totalBytes: total } : {}),
    ...(used !== undefined ? { usedBytes: used } : {}),
    ...(available !== undefined ? { availableBytes: available } : {}),
    ...(num(stats?.utilization) !== undefined
      ? { utilizationPercent: Math.round((stats!.utilization as number) * 10) / 10 }
      : {}),
    ...(str(modern?.type) ? { type: modern!.type } : {}),
    ...(str(ustorage?.raid) ? { raid: ustorage!.raid } : {}),
    ...((str(modern?.capability) ?? str(nvr.hardDriveState))
      ? { health: modern?.capability ?? nvr.hardDriveState }
      : {}),
    ...(disks
      ? {
          disks: disks.length,
          // Naming the unhealthy count rather than dumping four SMART tables:
          // the tables are enormous and the only question anyone asks of them
          // is whether a disk is failing.
          disksUnhealthy: disks.filter((d) => d.healthy !== undefined && d.healthy !== "good")
            .length,
        }
      : {}),
    // An NVR at 99% with isRecycling: true is working AS DESIGNED — it overwrites
    // the oldest footage continuously. Saying so inline stops a full-looking disk
    // being reported as a problem, which is the obvious wrong reading.
    ...(nvr.isRecycling === true
      ? {
          isRecycling: true,
          note: "Near-full with recycling on is normal: the console overwrites the oldest footage continuously rather than stopping.",
        }
      : {}),
  };
};

export const summarizeNvr = (nvr: Rec): Rec => {
  const system = rec(nvr.systemInfo);
  const memory = rec(system?.memory);
  const cpu = rec(system?.cpu);
  const upSince = num(nvr.upSince);
  return {
    id: nvr.id,
    name: nvr.name,
    host: nvr.host,
    type: nvr.type,
    // Pin this in the README: the private API is undocumented and moves between
    // releases, so the running version is the first thing to check when a
    // previously working tool starts returning 404.
    version: nvr.version,
    firmwareVersion: nvr.firmwareVersion,
    ...(str(nvr.marketName) ? { model: nvr.marketName } : {}),
    timezone: nvr.timezone,
    isRecordingDisabled: nvr.isRecordingDisabled,
    storage: summarizeStorage(nvr),
    ...(memory ? { memory: { available: memory.available, total: memory.total } } : {}),
    ...(cpu ? { cpu: { load: cpu.averageLoad, temperature: cpu.temperature } } : {}),
    // 7.x reports when the console came up rather than how long it has been up.
    ...(upSince !== undefined
      ? {
          upSince: new Date(upSince).toISOString(),
          uptimeSeconds: Math.round((Date.now() - upSince) / 1000),
        }
      : num(nvr.uptime) !== undefined
        ? { uptimeSeconds: Math.round((nvr.uptime as number) / 1000) }
        : {}),
    lastSeen: isoTime(nvr.lastSeen),
  };
};

/**
 * The bootstrap document is the entire console state and must never be returned
 * raw — it is the single largest context bomb this API offers. This reduces it
 * to the NVR summary plus per-type counts, which is what "tell me about my
 * system" actually wants.
 */
export const summarizeBootstrap = (bootstrap: Rec): Rec => {
  const count = (key: string): number =>
    Array.isArray(bootstrap[key]) ? (bootstrap[key] as unknown[]).length : 0;

  return {
    nvr: isRecord(bootstrap.nvr) ? summarizeNvr(bootstrap.nvr) : undefined,
    devices: {
      cameras: count("cameras"),
      lights: count("lights"),
      sensors: count("sensors"),
      viewers: count("viewers"),
      chimes: count("chimes"),
      bridges: count("bridges"),
      doorlocks: count("doorlocks"),
    },
    liveviews: count("liveviews"),
    users: count("users"),
    lastUpdateId: bootstrap.lastUpdateId,
  };
};
