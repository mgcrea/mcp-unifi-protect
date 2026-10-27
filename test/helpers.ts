import { vi } from "vitest";

/**
 * The shape of the injected fetch. Declared explicitly because `vi.fn(async () => …)`
 * infers a zero-argument signature, which makes `mock.calls[0][0]` a type error
 * — and asserting on the URL and headers a tool actually sent is most of the
 * value of these tests.
 */
export type FetchLike = (url: unknown, init?: unknown) => Promise<Response>;

/** A typed fetch mock whose recorded calls can be indexed. */
export const fetchMock = (impl: FetchLike): ReturnType<typeof vi.fn<FetchLike>> =>
  vi.fn<FetchLike>(impl);

/** The url of the nth recorded call. */
export const calledUrl = (mock: ReturnType<typeof vi.fn<FetchLike>>, n = 0): string =>
  String(mock.mock.calls[n]?.[0]);

/** The init of the nth recorded call, typed for assertions. */
export const calledInit = <T = Record<string, unknown>>(
  mock: ReturnType<typeof vi.fn<FetchLike>>,
  n = 0,
): T => mock.mock.calls[n]?.[1] as T;

/** An ISO BMFF box: 32-bit size, four-character type, then the body. */
export const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/** The shared body of `mvhd` and `mdhd`, version 0 (32-bit) or 1 (64-bit), padded. */
export const clockBody = (timescale: number, duration: number, version: 0 | 1 = 0): Uint8Array => {
  const times = version === 1 ? 16 : 8;
  const out = new Uint8Array(4 + times + 4 + (version === 1 ? 8 : 4) + 8);
  const view = new DataView(out.buffer);
  view.setUint8(0, version);
  view.setUint32(4 + times, timescale);
  if (version === 1) view.setBigUint64(8 + times, BigInt(duration));
  else view.setUint32(8 + times, duration);
  return out;
};

const handlerBody = (handler: string): Uint8Array => {
  const out = new Uint8Array(24);
  out.set(new TextEncoder().encode(handler), 8);
  return out;
};

/**
 * A minimal MP4 shaped like a Protect export: an audio and a video track with
 * their own clocks, and a movie header carrying the longer of the two.
 */
export const mp4Fixture = (opts: {
  movie: [timescale: number, duration: number];
  tracks: { handler: string; clock: [timescale: number, duration: number]; version?: 0 | 1 }[];
}): Uint8Array =>
  concat(
    box("ftyp", new TextEncoder().encode("mp42")),
    box(
      "moov",
      box("mvhd", clockBody(...opts.movie)),
      ...opts.tracks.map((t) =>
        box(
          "trak",
          box("tkhd", new Uint8Array(84)),
          box(
            "mdia",
            box("mdhd", clockBody(t.clock[0], t.clock[1], t.version ?? 0)),
            box("hdlr", handlerBody(t.handler)),
          ),
        ),
      ),
    ),
    box("mdat", new Uint8Array(16)),
  );

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
