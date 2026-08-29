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
