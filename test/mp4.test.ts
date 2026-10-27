import { describe, expect, it } from "vitest";

import { readMp4Timing } from "#/client/mp4";

import { box, mp4Fixture } from "./helpers.js";

describe("readMp4Timing", () => {
  // The durations of a real one-hour Protect export (a G4 Bullet on channel 2):
  // the audio clock runs short of the video, and the movie takes the longer.
  const hour = mp4Fixture({
    movie: [1000, 3_600_958],
    tracks: [
      { handler: "soun", clock: [48_000, 172_793_856] },
      { handler: "vide", clock: [90_000, 324_086_220] },
    ],
  });

  it("reads the movie duration and each track's own clock", () => {
    expect(readMp4Timing(hour)).toEqual({
      durationSeconds: 3600.958,
      tracks: [
        { handler: "soun", durationSeconds: 3599.872, timescale: 48_000 },
        { handler: "vide", durationSeconds: 3600.958, timescale: 90_000 },
      ],
    });
  });

  it("reads version 1 headers with 64-bit durations", () => {
    const timing = readMp4Timing(
      mp4Fixture({
        movie: [1000, 61_056],
        tracks: [{ handler: "soun", clock: [16_000, 976_896], version: 1 }],
      }),
    );
    expect(timing?.tracks[0]).toEqual({
      handler: "soun",
      durationSeconds: 61.056,
      timescale: 16_000,
    });
  });

  it("falls back to the longest track when the movie duration is unknown", () => {
    const timing = readMp4Timing(
      mp4Fixture({
        movie: [1000, 0xffff_ffff],
        tracks: [
          { handler: "soun", clock: [16_000, 960_000] },
          { handler: "vide", clock: [90_000, 5_490_000] },
        ],
      }),
    );
    expect(timing?.durationSeconds).toBe(61);
  });

  it("returns undefined rather than throwing on anything that is not a readable MP4", () => {
    expect(readMp4Timing(new Uint8Array([0]))).toBeUndefined();
    expect(readMp4Timing(new TextEncoder().encode("<html>login</html>"))).toBeUndefined();
    expect(readMp4Timing(box("moov"))).toBeUndefined();
    // A header claiming more bytes than there are.
    const truncated = hour.subarray(0, 60);
    expect(readMp4Timing(truncated)).toBeUndefined();
  });
});
