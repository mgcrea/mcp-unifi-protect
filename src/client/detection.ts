// What a camera will actually detect, and why a search came back empty.
//
// UniFi Protect gates smart detection in TWO places, and the UI shows only one
// of them clearly. `smartDetectSettings.objectTypes` on the device is the master
// switch; each entry in `smartDetectZones[].objectTypes` says what that zone
// asks for. The zone can ask for `person` while the device list omits it, and
// the console then reports nothing, forever, with no error anywhere.
//
// That is not a hypothetical. A doorbell here had `zone: [person, vehicle,
// animal]` against `device: [animal]`, so a person search returned zero events
// across seven days — while people walked past nightly. Zero results read as
// "nobody was there", which is the most expensive wrong answer this server can
// give, so every read path cross-checks the gate and says when the detector was
// simply off.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Values the console REPORTS but REFUSES to accept back.
 *
 * `smoke_cmonx` is returned in `smartDetectSettings.audioTypes` but is absent
 * from `featureFlags.smartDetectAudioTypes`, and a PATCH containing it fails
 * with `400 The smart detection feature is not enabled for: smoke_cmonx`. Any
 * read-modify-write that echoes the list back therefore breaks — which is
 * exactly how this was found. Write paths must filter against the capability
 * list rather than trusting what a read returned.
 */
export const isSettableAudioType = (type: string, capable: readonly string[]): boolean =>
  capable.includes(type);

/**
 * Smart-detect values that are reported on events but are not themselves
 * switches. Asking for a licence plate needs `vehicle` enabled; asking for a
 * face needs `person`. Warning about them directly would be wrong.
 */
const DERIVED_TYPES: Record<string, string> = {
  licensePlate: "vehicle",
  face: "person",
};

/** The object types that are actually gated by `smartDetectSettings.objectTypes`. */
export const GATED_OBJECT_TYPES = ["person", "vehicle", "animal", "package"] as const;

export const isAudioType = (type: string): boolean => type.startsWith("alrm");

/** Everything about one camera that decides whether a detection could occur. */
export type CameraFacts = {
  id: string;
  name: string;
  /** The master switch: `smartDetectSettings.objectTypes`. */
  enabled: string[];
  /** The union of what the zones ask for. */
  zone: string[];
  /** What the hardware supports: `featureFlags.smartDetectTypes`. */
  capable: string[];
  audioEnabled: string[];
  audioCapable: string[];
  hasSmartDetect: boolean;
  isConnected: boolean;
  recordingMode: string | undefined;
  motionDetectionEnabled: boolean | undefined;
  /** Types a zone asks for that the device list blocks — the silent failure. */
  blocked: string[];
};

export const cameraFacts = (camera: Rec): CameraFacts => {
  const flags = isRecord(camera.featureFlags) ? camera.featureFlags : {};
  const smart = isRecord(camera.smartDetectSettings) ? camera.smartDetectSettings : {};
  const recording = isRecord(camera.recordingSettings) ? camera.recordingSettings : {};
  const zones = Array.isArray(camera.smartDetectZones) ? camera.smartDetectZones : [];

  const enabled = strings(smart.objectTypes);
  const zone = [...new Set(zones.filter(isRecord).flatMap((z) => strings(z.objectTypes)))];

  return {
    id: str(camera.id) ?? "",
    name: str(camera.name) ?? str(camera.id) ?? "(unnamed)",
    enabled,
    zone,
    capable: strings(flags.smartDetectTypes),
    audioEnabled: strings(smart.audioTypes),
    audioCapable: strings(flags.smartDetectAudioTypes),
    hasSmartDetect: flags.hasSmartDetect === true,
    isConnected: camera.isConnected === true,
    recordingMode: str(recording.mode),
    motionDetectionEnabled:
      typeof recording.enableMotionDetection === "boolean"
        ? recording.enableMotionDetection
        : undefined,
    blocked: zone.filter((t) => !enabled.includes(t)),
  };
};

export type CameraIndex = ReadonlyMap<string, CameraFacts>;

export const buildCameraIndex = (cameras: unknown): CameraIndex => {
  const index = new Map<string, CameraFacts>();
  if (!Array.isArray(cameras)) return index;
  for (const camera of cameras) {
    if (!isRecord(camera)) continue;
    const facts = cameraFacts(camera);
    if (facts.id) index.set(facts.id, facts);
  }
  return index;
};

/** Would this camera ever emit `type`? */
const detects = (facts: CameraFacts, type: string): boolean => {
  if (isAudioType(type)) return facts.audioEnabled.includes(type);
  const gate = DERIVED_TYPES[type] ?? type;
  return facts.enabled.includes(gate);
};

/**
 * Explain, before anyone reads the count, why a smart-detection search could not
 * have returned anything from a given camera.
 *
 * Returned whether or not the result was empty: a search across ten cameras
 * where two have the detector off is still misleading at a non-zero count,
 * because those two contributed nothing and nothing says so.
 */
export const detectionWarnings = (
  requested: readonly string[],
  cameras: readonly CameraFacts[],
): string[] => {
  if (requested.length === 0 || cameras.length === 0) return [];
  const warnings: string[] = [];

  for (const type of requested) {
    const gate = DERIVED_TYPES[type] ?? type;
    const off = cameras.filter((c) => c.hasSmartDetect && !detects(c, type));
    if (off.length === 0) continue;

    const names = off.map((c) => c.name).join(", ");
    const derived =
      DERIVED_TYPES[type] !== undefined
        ? ` (\`${type}\` requires \`${gate}\`, which is what the console gates)`
        : "";
    warnings.push(
      `${off.length === cameras.length ? "No camera searched has" : `${names} ${off.length === 1 ? "does" : "do"} not have`} ` +
        `\`${type}\` detection enabled${derived}. Zero results for it mean the detector was OFF, ` +
        `not that nothing happened. Search \`types:["motion"]\` and inspect thumbnails instead, ` +
        `or enable it with unifi_protect_set_camera_detections.`,
    );
  }

  // A zone asking for something the device blocks is worth saying even when the
  // caller did not ask for that type — it is a live misconfiguration.
  for (const camera of cameras) {
    if (camera.blocked.length === 0) continue;
    warnings.push(
      `${camera.name} has a detection zone asking for ${camera.blocked.map((t) => `\`${t}\``).join(", ")} ` +
        `while the device list allows only ${camera.enabled.map((t) => `\`${t}\``).join(", ") || "nothing"}. ` +
        `The zone setting has no effect — the device list is the gate.`,
    );
  }

  return warnings;
};
