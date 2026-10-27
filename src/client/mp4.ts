// Just enough of ISO BMFF (MP4) to say how long an export runs, per track.
//
// A Protect export does not start where it was asked to: the console cuts on
// the keyframe before the requested start, so the file runs up to a second or
// so long at the front, by a different amount every time. Anyone lining two
// exports up — two cameras that heard the same voices, say — needs the real
// start, and the only clock the file offers is its duration. Reading that
// here saves every caller a trip through ffprobe.

export type Mp4Track = {
  /** The handler type: `vide`, `soun`, or whatever else the file carries. */
  handler: string;
  durationSeconds: number;
  /** Units per second of the track's media clock; an audio track's sample rate. */
  timescale: number;
};

export type Mp4Timing = {
  /** The movie's duration, the longest of its tracks. */
  durationSeconds: number;
  tracks: Mp4Track[];
};

type Box = { type: string; start: number; end: number; body: number };

/** The boxes directly inside [from, to). Stops at the first malformed header. */
const boxes = (view: DataView, from: number, to: number): Box[] => {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    );
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(view.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = to - at; // runs to the end of its parent
    }
    if (size < body - at || at + size > to) break;
    found.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return found;
};

const child = (view: DataView, parent: Box, type: string): Box | undefined =>
  boxes(view, parent.body, parent.end).find((b) => b.type === type);

/**
 * `mvhd` and `mdhd` share a layout: version 0 has 32-bit times, version 1 has
 * 64-bit ones, and the timescale sits between creation/modification times and
 * the duration. An all-ones duration means "unknown", as a fragmented file
 * writes it.
 */
const timing = (view: DataView, box: Box): { timescale: number; duration: number } | undefined => {
  const version = view.getUint8(box.body);
  const scaleAt = box.body + 4 + (version === 1 ? 16 : 8);
  if (scaleAt + (version === 1 ? 12 : 8) > box.end) return undefined;
  const timescale = view.getUint32(scaleAt);
  const raw = version === 1 ? view.getBigUint64(scaleAt + 4) : BigInt(view.getUint32(scaleAt + 4));
  const unknown = version === 1 ? 0xffff_ffff_ffff_ffffn : 0xffff_ffffn;
  if (timescale === 0 || raw === unknown) return undefined;
  return { timescale, duration: Number(raw) };
};

const seconds = (value: number, timescale: number): number =>
  Math.round((value / timescale) * 1000) / 1000;

/**
 * Durations out of an MP4's `moov` box, or undefined when the file has none
 * worth reading (fragmented, truncated, or not an MP4 at all). Never throws:
 * this is extra information on a download that already succeeded.
 */
export const readMp4Timing = (bytes: Uint8Array): Mp4Timing | undefined => {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const moov = boxes(view, 0, bytes.byteLength).find((b) => b.type === "moov");
    if (!moov) return undefined;
    const inside = boxes(view, moov.body, moov.end);

    const tracks: Mp4Track[] = [];
    for (const trak of inside.filter((b) => b.type === "trak")) {
      const mdia = child(view, trak, "mdia");
      const mdhd = mdia && child(view, mdia, "mdhd");
      const hdlr = mdia && child(view, mdia, "hdlr");
      const clock = mdhd && timing(view, mdhd);
      if (!clock || !hdlr || hdlr.body + 12 > hdlr.end) continue;
      const handler = String.fromCharCode(
        ...Array.from(bytes.subarray(hdlr.body + 8, hdlr.body + 12)),
      );
      tracks.push({
        handler,
        durationSeconds: seconds(clock.duration, clock.timescale),
        timescale: clock.timescale,
      });
    }

    const mvhd = inside.find((b) => b.type === "mvhd");
    const movie = mvhd && timing(view, mvhd);
    const durationSeconds = movie
      ? seconds(movie.duration, movie.timescale)
      : Math.max(0, ...tracks.map((t) => t.durationSeconds));
    if (durationSeconds <= 0) return undefined;
    return { durationSeconds, tracks };
  } catch {
    return undefined;
  }
};
