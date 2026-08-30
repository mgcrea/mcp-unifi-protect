import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { cameraFacts, type CameraFacts } from "#/client/detection";
import type { ProtectClient } from "#/client/protect";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Severity is about consequence, not tidiness. `high` means the system is not
 * doing what someone believes it is doing — footage is not being kept, or a
 * detector that looks enabled is off. `low` is inconsistency worth knowing
 * about but harmless.
 */
type Severity = "high" | "medium" | "low";

type Finding = {
  severity: Severity;
  check: string;
  device: string;
  detail: string;
  fix: string;
};

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** The most common non-`never` recording mode, used to spot the odd one out. */
const majorityMode = (cameras: CameraFacts[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const c of cameras) {
    if (!c.recordingMode || c.recordingMode === "never") continue;
    counts.set(c.recordingMode, (counts.get(c.recordingMode) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [mode, n] of counts) {
    if (n > bestCount) {
      best = mode;
      bestCount = n;
    }
  }
  return best;
};

export const auditCameras = (cameras: CameraFacts[], nvr: Rec): Finding[] => {
  const findings: Finding[] = [];
  const smart = cameras.filter((c) => c.hasSmartDetect);
  const usualMode = majorityMode(cameras);

  for (const camera of cameras) {
    // The one that started all this: a zone asking for a type the device list
    // blocks produces nothing, forever, and looks configured in the UI.
    if (camera.blocked.length > 0) {
      findings.push({
        severity: "high",
        check: "detection-gate-blocked",
        device: camera.name,
        detail:
          `A detection zone asks for ${camera.blocked.join(", ")} but the device list allows ` +
          `only ${camera.enabled.join(", ") || "nothing"}. The device list is the gate, so ` +
          "those detections never fire and searches for them return zero.",
        fix:
          `unifi_protect_set_camera_detections with objectTypes including ` +
          `${camera.blocked.join(", ")}, or narrow the zone to match what is enabled.`,
      });
    }

    if (camera.hasSmartDetect && camera.enabled.length === 0) {
      findings.push({
        severity: "medium",
        check: "detection-off",
        device: camera.name,
        detail:
          `Supports ${camera.capable.join(", ") || "smart detection"} but has none enabled, so ` +
          "it only produces plain motion events with no classification.",
        fix: "unifi_protect_set_camera_detections to enable the types you want.",
      });
    }

    if (!camera.isConnected) {
      findings.push({
        severity: "high",
        check: "camera-offline",
        device: camera.name,
        detail: "Offline — it is recording nothing and there will be no footage for this period.",
        fix: "Check power and network, then unifi_protect_get_camera for its last-seen time.",
      });
    }

    if (camera.recordingMode === "never") {
      findings.push({
        severity: "high",
        check: "recording-off",
        device: camera.name,
        detail:
          "Recording mode is `never`, so nothing is being kept" +
          (usualMode ? ` while other cameras record \`${usualMode}\`` : "") +
          ". The camera is otherwise fine; there will simply be no footage to search.",
        fix: "unifi_protect_set_camera_recording_mode if this was not deliberate.",
      });
    }

    if (camera.motionDetectionEnabled === false) {
      findings.push({
        severity: "medium",
        check: "motion-detection-off",
        device: camera.name,
        detail:
          "Motion detection is off, so plain motion events are not recorded" +
          (camera.enabled.length > 0
            ? ` (smart detection for ${camera.enabled.join(", ")} still works)`
            : " and nothing else is enabled either") +
          ".",
        fix: "Enable motion detection in Protect if motion events are wanted.",
      });
    }
  }

  // Audio detection is compared across peers rather than against the hardware:
  // every camera supporting it and most having it on makes the exception look
  // like an oversight, which is exactly what it usually is.
  const audioPeers = smart.filter((c) => c.audioCapable.length > 0);
  for (const type of new Set(audioPeers.flatMap((c) => c.audioCapable))) {
    const withIt = audioPeers.filter((c) => c.audioEnabled.includes(type));
    const without = audioPeers.filter(
      (c) => c.audioCapable.includes(type) && !c.audioEnabled.includes(type),
    );
    if (withIt.length === 0 || without.length === 0) continue;
    if (withIt.length < audioPeers.length / 2) continue;
    findings.push({
      severity: "low",
      check: "audio-detection-inconsistent",
      device: without.map((c) => c.name).join(", "),
      detail:
        `\`${type}\` is enabled on ${withIt.length} of ${audioPeers.length} capable cameras but ` +
        `not ${without.length === 1 ? "this one" : "these"}.`,
      fix: `unifi_protect_set_camera_detections with audioTypes including ${type}.`,
    });
  }

  if (nvr.isRecordingDisabled === true) {
    findings.push({
      severity: "high",
      check: "nvr-recording-disabled",
      device: String(nvr.name ?? "console"),
      detail: "Recording is disabled console-wide. No camera is keeping footage.",
      fix: "Re-enable recording in Protect.",
    });
  }

  const stats = isRecord(nvr.storageStats) ? nvr.storageStats : undefined;
  const utilization = typeof stats?.utilization === "number" ? stats.utilization : undefined;
  if (utilization !== undefined && utilization > 95 && nvr.isRecycling !== true) {
    findings.push({
      severity: "high",
      check: "storage-full",
      device: String(nvr.name ?? "console"),
      detail:
        `Storage is ${utilization.toFixed(1)}% full and recycling is OFF, so recording will ` +
        "stop rather than overwrite the oldest footage.",
      fix: "Enable recycling, shorten retention, or add storage.",
    });
  }

  return findings.toSorted((a, b) => ORDER[a.severity] - ORDER[b.severity]);
};

export const registerAuditTools = (
  server: McpServer,
  client: ProtectClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "unifi_protect_check_settings",
    {
      title: "UniFi Protect: Check Settings",
      description:
        "Check every camera and the console for settings that are inconsistent, or that mean " +
        "the system is not doing what someone believes it is. Finds detectors that look " +
        "enabled but are gated off, cameras keeping no footage, offline devices, motion " +
        "detection switched off, and storage about to stop recording. This is the tool for " +
        '"are my camera settings correct" — the checks encode traps that are invisible in the ' +
        "Protect UI, notably a detection zone asking for an object type the device list " +
        "blocks. Read-only: it reports findings and names the tool that would fix each one, " +
        "and changes nothing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const [rawCameras, nvr] = await Promise.all([
          client.get<unknown>("cameras"),
          client.get<Rec>("nvr"),
        ]);
        const cameras = (Array.isArray(rawCameras) ? rawCameras : [])
          .filter(isRecord)
          .map(cameraFacts);
        const findings = auditCameras(cameras, nvr ?? {});

        return {
          checked: {
            cameras: cameras.length,
            smartCapable: cameras.filter((c) => c.hasSmartDetect).length,
          },
          counts: {
            high: findings.filter((f) => f.severity === "high").length,
            medium: findings.filter((f) => f.severity === "medium").length,
            low: findings.filter((f) => f.severity === "low").length,
          },
          ...(findings.length === 0
            ? { ok: true, note: "No inconsistencies found." }
            : { findings }),
        };
      }),
  );
};
