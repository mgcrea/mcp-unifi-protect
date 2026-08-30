import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (body: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }],
});

/**
 * Prompts carry the PROCEDURE, which is the part that cannot be inferred from a
 * tool list.
 *
 * Both of these encode the same hard-won lesson: on this system a smart-detection
 * search returning zero is ambiguous between "nobody was there" and "the detector
 * was switched off", and the second case is only resolvable by falling back to
 * motion events and looking at the frames. A model reading tool descriptions
 * alone reliably reports the first.
 *
 * They are a convenience, not a safety net — a client can call the tools
 * directly and skip all of this — which is why `unifi_protect_list_events` also
 * returns the warning inline.
 */
export const registerPrompts = (server: McpServer): void => {
  server.registerPrompt(
    "check_camera_settings",
    {
      title: "Check camera settings",
      description:
        "Audit every camera for inconsistent or self-defeating settings, and explain what is " +
        "worth changing. Read-only.",
    },
    () =>
      text(
        [
          "Check whether my UniFi Protect cameras are configured consistently.",
          "",
          "1. Call `unifi_protect_check_settings`. It returns findings ranked by consequence,",
          "   each naming the tool that would fix it.",
          "2. Report the findings grouped by severity, in plain language. For each one say what",
          "   the CONSEQUENCE is — what someone currently believes is happening that is not —",
          "   rather than restating the setting.",
          "3. Do NOT change anything. Several findings have two valid opposite fixes: a zone",
          "   asking for a detection the device blocks can be resolved by enabling the",
          "   detection OR by narrowing the zone, and which is right depends on what the camera",
          "   is for. A camera in a bedroom or a bathroom is the obvious case — say so and ask.",
          "4. Where a finding might be deliberate (recording set to `never`, motion detection",
          "   off on an indoor camera), present it as a question rather than a defect.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "who_passed",
    {
      title: "Who passed by",
      description:
        "Find out who or what was present at a place during a time window, falling back to " +
        "motion frames on cameras whose detectors are off.",
      argsSchema: {
        location: z
          .string()
          .optional()
          .describe('Place to look at, e.g. "front". Omit to search every camera.'),
        start: z
          .string()
          .describe('Start of the window in the console\'s local clock, e.g. "1am" or "22:00".'),
        end: z.string().describe('End of the window, e.g. "6am".'),
      },
    },
    ({ location, start, end }) =>
      text(
        [
          `Find out who or what passed ${location ? `the ${location}` : "any camera"} between ${start} and ${end}.`,
          "",
          "Times are in the console's local zone; `unifi_protect_list_events` accepts them",
          "directly, so pass them through rather than converting by hand.",
          "",
          '1. Search with `unifi_protect_list_events`, types `["smartDetectZone"]` and',
          `   smartDetectTypes ["person"]${location ? `, location "${location}"` : ""}.`,
          "2. READ THE `warnings` FIELD BEFORE REPORTING ANYTHING. A camera with person",
          "   detection disabled contributes zero matches, and zero is NOT evidence that nobody",
          "   was there. If any warning says a detector is off, you have not answered the",
          "   question yet — continue to step 3 for those cameras.",
          "3. For each camera whose detector was off, search the same window again with types",
          '   `["motion"]` restricted to that camera, then call',
          "   `unifi_protect_get_event_thumbnails` on the results and LOOK at the frames. This",
          "   is the only way to tell a person from a branch on such a camera.",
          "4. Report each sighting with its LOCAL time and camera name, and say how it was",
          "   established — classified by the camera, or seen by you in a frame. Keep those",
          "   two apart: one is the console's judgement and one is yours.",
          "5. Say plainly what was NOT covered: cameras that were offline, not recording, or",
          "   whose motion zone excludes part of the scene. A thumbnail is the triggering frame",
          "   only, so someone entering later in a clip does not appear in it.",
        ].join("\n"),
      ),
  );
};
