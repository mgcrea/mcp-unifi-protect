import { describe, expect, it, vi } from "vitest";

import { staticSessionProvider, type SessionProvider } from "#/client/auth";
import { ProtectApiError } from "#/client/errors";
import { buildQuery, ProtectClient } from "#/client/protect";

import { calledInit, calledUrl, fetchMock, type FetchLike } from "./helpers.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const makeClient = (
  fetchImpl: typeof fetch,
  opts: { session?: SessionProvider; maxDownloadBytes?: number } = {},
): ProtectClient =>
  new ProtectClient({
    baseUrl: "https://192.168.1.1",
    session: opts.session ?? staticSessionProvider(),
    maxRetries: 2,
    userAgent: "test",
    maxDownloadBytes: opts.maxDownloadBytes ?? 1_000_000,
    fetch: fetchImpl,
  });

describe("buildQuery", () => {
  it("repeats array parameters rather than joining them", () => {
    // Protect reads `types` as repeated params. A comma-joined value matches no
    // event type at all and returns an empty list rather than an error.
    expect(buildQuery({ types: ["motion", "ring"] })).toBe("?types=motion&types=ring");
  });

  it("drops undefined values", () => {
    expect(buildQuery({ a: "1", b: undefined })).toBe("?a=1");
  });

  it("returns an empty string for no query", () => {
    expect(buildQuery(undefined)).toBe("");
    expect(buildQuery({})).toBe("");
  });
});

describe("request paths", () => {
  it("prefixes the private API path", async () => {
    const fetchImpl = fetchMock(async () => json([]));
    await makeClient(fetchImpl as unknown as typeof fetch).get("cameras");
    expect(calledUrl(fetchImpl)).toBe("https://192.168.1.1/proxy/protect/api/cameras");
  });

  it("sends the session cookie and CSRF token on every call", async () => {
    const fetchImpl = fetchMock(async () => json([]));
    await makeClient(fetchImpl as unknown as typeof fetch).get("cameras");
    const init = calledInit<{ headers: Record<string, string> }>(fetchImpl);
    expect(init.headers.cookie).toBe("TOKEN=test");
    expect(init.headers["x-csrf-token"]).toBe("csrf-test");
  });

  it("never follows redirects", async () => {
    // UniFi OS bounces an expired session to a login page; following it turns a
    // recoverable 401 into a 200 carrying HTML that parses as neither JSON nor
    // an image.
    const fetchImpl = fetchMock(async () => json([]));
    await makeClient(fetchImpl as unknown as typeof fetch).get("cameras");
    expect(calledInit<{ redirect: string }>(fetchImpl).redirect).toBe("manual");
  });
});

describe("retry behaviour", () => {
  it("re-authenticates once on a 401 and retries", async () => {
    const invalidate = vi.fn();
    const session: SessionProvider = {
      ...staticSessionProvider(),
      invalidate,
    };
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json([{ id: "a" }]));

    const result = await makeClient(fetchImpl as unknown as typeof fetch, { session }).get(
      "cameras",
    );

    expect(invalidate).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: "a" }]);
  });

  it("gives up after maxRetries and reports the status", async () => {
    const fetchImpl = fetchMock(async () => json({ error: "nope" }, 401));
    await expect(makeClient(fetchImpl as unknown as typeof fetch).get("cameras")).rejects.toThrow(
      ProtectApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("treats an empty body as null rather than failing to parse", async () => {
    // Many PATCH endpoints answer 200 with no body rather than 204.
    const fetchImpl = fetchMock(async () => new Response("", { status: 200 }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).patch("cameras/x", { name: "y" }),
    ).resolves.toBeNull();
  });
});

describe("error messages", () => {
  it("names the likely cause of a 404 on an undocumented API", async () => {
    const fetchImpl = fetchMock(async () => json({ error: "not found" }, 404));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).get("cameras/missing"),
    ).rejects.toThrow(/undocumented|get_system_info/i);
  });

  it("suggests a permissions problem on a 403", async () => {
    const fetchImpl = fetchMock(async () => json({ error: "forbidden" }, 403));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).patch("cameras/x", {}),
    ).rejects.toThrow(/permission|view-only/i);
  });
});

describe("binary downloads", () => {
  it("returns bytes and content type", async () => {
    const fetchImpl = fetchMock(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const result = await makeClient(fetchImpl as unknown as typeof fetch).requestBytes(
      "cameras/x/snapshot",
    );
    expect(result.contentType).toBe("image/jpeg");
    expect(result.bytes.byteLength).toBe(3);
  });

  it("refuses a download over the byte cap before reading it", async () => {
    const fetchImpl = fetchMock(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": "999999999" },
        }),
    );
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch, { maxDownloadBytes: 1000 }).requestBytes(
        "video/export",
      ),
    ).rejects.toThrow(/over the 1000-byte limit/);
  });

  it("catches an oversized download when no Content-Length is sent", async () => {
    const fetchImpl = fetchMock(async () => new Response(new Uint8Array(2000), { status: 200 }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch, { maxDownloadBytes: 1000 }).requestBytes(
        "video/export",
      ),
    ).rejects.toThrow(/2000 bytes/);
  });
});
