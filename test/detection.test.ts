import { describe, expect, it } from "vitest";

import { buildCameraIndex, cameraFacts, detectionWarnings } from "../src/client/detection.js";
import { resolveLocation } from "../src/client/locations.js";
import { auditCameras } from "../src/tools/audit.js";

/** The real shape, trimmed: a doorbell whose zone asks for more than the device allows. */
const carillon = {
  id: "cam-carillon",
  name: "Carillon",
  isConnected: true,
  featureFlags: {
    hasSmartDetect: true,
    smartDetectTypes: ["person", "vehicle", "animal", "package"],
    smartDetectAudioTypes: ["alrmSmoke", "alrmCmonx", "alrmBabyCry", "alrmSpeak"],
  },
  smartDetectSettings: {
    objectTypes: ["animal"],
    // The console reports smoke_cmonx but refuses it on write.
    audioTypes: ["alrmSmoke", "alrmCmonx", "alrmBabyCry", "alrmSpeak", "smoke_cmonx"],
  },
  smartDetectZones: [{ id: 1, objectTypes: ["person", "vehicle", "animal"] }],
  recordingSettings: { mode: "always", enableMotionDetection: true },
};

const portail = {
  id: "cam-portail",
  name: "Portail",
  isConnected: true,
  featureFlags: {
    hasSmartDetect: true,
    smartDetectTypes: ["person", "vehicle", "animal"],
    smartDetectAudioTypes: ["alrmSmoke", "alrmSpeak"],
  },
  smartDetectSettings: { objectTypes: ["person", "vehicle", "animal"], audioTypes: ["alrmSmoke"] },
  smartDetectZones: [{ id: 1, objectTypes: ["person", "vehicle", "animal"] }],
  recordingSettings: { mode: "always", enableMotionDetection: true },
};

describe("cameraFacts", () => {
  it("separates what a zone asks for from what the device allows", () => {
    const facts = cameraFacts(carillon);
    expect(facts.enabled).toEqual(["animal"]);
    expect(facts.zone).toEqual(["person", "vehicle", "animal"]);
    // The whole point: person is requested by the zone and blocked by the device.
    expect(facts.blocked).toEqual(["person", "vehicle"]);
  });

  it("reports no gap when the two agree", () => {
    expect(cameraFacts(portail).blocked).toEqual([]);
  });

  it("survives a camera with no smart detection at all", () => {
    const facts = cameraFacts({ id: "c", name: "Patio", featureFlags: {} });
    expect(facts.hasSmartDetect).toBe(false);
    expect(facts.enabled).toEqual([]);
    expect(facts.blocked).toEqual([]);
  });
});

describe("detectionWarnings", () => {
  // The failure this exists to prevent: a person search on a camera with person
  // detection off returns zero, and zero reads as "nobody was there".
  it("says when a requested type could not have matched", () => {
    const warnings = detectionWarnings(["person"], [cameraFacts(carillon)]);
    expect(warnings.join(" ")).toContain("detector was OFF");
    expect(warnings.join(" ")).toContain("`person`");
  });

  it("stays quiet when every camera has the detector on", () => {
    expect(detectionWarnings(["person"], [cameraFacts(portail)])).toEqual([]);
  });

  it("maps a derived type to the switch that actually gates it", () => {
    // licensePlate is reported on events but is not itself a switch; vehicle is.
    const warnings = detectionWarnings(["licensePlate"], [cameraFacts(carillon)]);
    expect(warnings.join(" ")).toContain("requires `vehicle`");
  });

  it("flags a blocked zone even when the caller asked for something else", () => {
    const warnings = detectionWarnings(["animal"], [cameraFacts(carillon)]);
    expect(warnings.join(" ")).toContain("has no effect");
  });

  it("names the cameras that are off rather than generalising", () => {
    const warnings = detectionWarnings(["person"], [cameraFacts(carillon), cameraFacts(portail)]);
    expect(warnings[0]).toContain("Carillon");
    expect(warnings[0]).not.toContain("Portail does not");
  });
});

describe("auditCameras", () => {
  it("ranks a blocked detection gate as high severity", () => {
    const findings = auditCameras([cameraFacts(carillon)], {});
    const gate = findings.find((f) => f.check === "detection-gate-blocked");
    expect(gate?.severity).toBe("high");
    expect(gate?.fix).toContain("unifi_protect_set_camera_detections");
  });

  it("flags a camera that keeps no footage", () => {
    const off = { ...portail, recordingSettings: { mode: "never" } };
    const findings = auditCameras([cameraFacts(off)], {});
    expect(findings.some((f) => f.check === "recording-off" && f.severity === "high")).toBe(true);
  });

  it("flags motion detection switched off", () => {
    const off = {
      ...portail,
      recordingSettings: { mode: "always", enableMotionDetection: false },
    };
    expect(
      auditCameras([cameraFacts(off)], {}).some((f) => f.check === "motion-detection-off"),
    ).toBe(true);
  });

  it("treats a near-full disk as fine when recycling is on", () => {
    const nvr = { storageStats: { utilization: 99.6 }, isRecycling: true };
    expect(auditCameras([], nvr).some((f) => f.check === "storage-full")).toBe(false);
  });

  it("flags a near-full disk when recycling is off", () => {
    const nvr = { storageStats: { utilization: 99.6 }, isRecycling: false };
    expect(auditCameras([], nvr).some((f) => f.check === "storage-full")).toBe(true);
  });

  it("finds nothing to report on a consistent system", () => {
    expect(auditCameras([cameraFacts(portail)], {})).toEqual([]);
  });
});

describe("resolveLocation", () => {
  const index = buildCameraIndex([carillon, portail]);

  it("resolves camera names case-insensitively to ids", () => {
    const { ids, unmatched } = resolveLocation("front", { front: ["carillon", "Portail"] }, index);
    expect(ids).toEqual(["cam-carillon", "cam-portail"]);
    expect(unmatched).toEqual([]);
  });

  it("reports an entry that matches no camera rather than dropping it", () => {
    const { ids, unmatched } = resolveLocation("front", { front: ["Carillon", "Typo"] }, index);
    expect(ids).toEqual(["cam-carillon"]);
    expect(unmatched).toEqual(["Typo"]);
  });

  it("names the configured locations when asked for an unknown one", () => {
    expect(() => resolveLocation("back", { front: [] }, index)).toThrow(/front/);
  });

  it("explains how to configure locations when none are set", () => {
    expect(() => resolveLocation("front", {}, index)).toThrow(/UNIFI_PROTECT_LOCATIONS/);
  });
});
