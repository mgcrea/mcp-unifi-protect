import type { Logger, SessionProvider } from "#/client/auth";
import { ProtectApiError } from "#/client/errors";
import { PRIVATE_API_PATH } from "#/config";

/** Array values become repeated params, which is how Protect expects `types`. */
export type Query = Record<string, string | number | boolean | string[] | undefined>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const value = res.headers.get("Retry-After");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // Protect reads `types` and `smartDetectTypes` as REPEATED parameters
    // (?types=motion&types=ring), not as a comma-joined string. A joined value
    // matches no event type at all and returns an empty list rather than an error.
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

export type ProtectClientOptions = {
  baseUrl: string;
  session: SessionProvider;
  maxRetries: number;
  userAgent: string;
  maxDownloadBytes: number;
  fetch?: typeof fetch;
  logger?: Logger;
};

export type BinaryResult = {
  bytes: Uint8Array;
  contentType: string;
};

/**
 * The private Protect API client. Every path passed in is relative to
 * `/proxy/protect/api` — callers write `cameras/abc123`, not the full path.
 */
export class ProtectClient {
  readonly baseUrl: string;
  private readonly session: SessionProvider;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly maxDownloadBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(opts: ProtectClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.session = opts.session;
    this.maxRetries = opts.maxRetries;
    this.userAgent = opts.userAgent;
    this.maxDownloadBytes = opts.maxDownloadBytes;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /** Absolute URL for a path relative to the private API root. */
  url(path: string, query?: Query): string {
    const clean = path.replace(/^\/+/, "");
    return `${this.baseUrl}${PRIVATE_API_PATH}/${clean}${buildQuery(query)}`;
  }

  /**
   * Perform one authenticated request, retrying on 401 (re-login), 429 and 5xx.
   * Returns the raw Response so callers can decide between JSON and bytes.
   */
  private async send(
    method: string,
    url: string,
    opts: { body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const hasBody = opts.body !== undefined;
    const bodyText = hasBody ? JSON.stringify(opts.body) : undefined;
    let attempt = 0;

    for (;;) {
      const auth = await this.session.headers();
      this.logger?.debug?.(`${method} ${url} (attempt ${attempt + 1})`);
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          ...auth,
          Accept: opts.accept ?? "application/json",
          "User-Agent": this.userAgent,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(bodyText !== undefined ? { body: bodyText } : {}),
        // Never follow a redirect: UniFi OS bounces an expired session to a
        // login page, and following it would turn a 401 we can recover from
        // into a 200 carrying HTML that parses as neither JSON nor an image.
        redirect: "manual",
      });

      // 401 means the cookie died mid-session. Drop it and re-run the handshake.
      if (res.status === 401 && attempt < this.maxRetries) {
        this.logger?.warn?.("HTTP 401 — re-authenticating and retrying");
        this.session.invalidate();
        attempt += 1;
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status} — retrying in ${delay}ms`);
        await sleep(delay);
        attempt += 1;
        continue;
      }

      return res;
    }
  }

  /** A JSON request against the private API. */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = this.url(path, opts.query);
    const res = await this.send(method, url, opts.body !== undefined ? { body: opts.body } : {});
    const text = await res.text();

    if (!res.ok) {
      throw new ProtectApiError(this.errorMessage(res, method, path, text), {
        status: res.status,
        path,
        errors: safeJsonParse(text),
      });
    }

    // Many PATCH endpoints answer 200 with an empty body rather than 204.
    if (res.status === 204 || text.trim() === "") return null as T;
    return safeJsonParse(text) as T;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query ? { query } : {});
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  patch<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  del<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, query ? { query } : {});
  }

  /**
   * Fetch a binary asset — a snapshot JPEG, an event thumbnail, an exported
   * MP4. Size is checked against `maxDownloadBytes` from Content-Length where
   * the console supplies one, and again after reading where it does not, so an
   * unexpectedly huge export fails with a clear message rather than by
   * exhausting the heap.
   */
  async requestBytes(
    path: string,
    opts: { query?: Query; accept?: string } = {},
  ): Promise<BinaryResult> {
    const url = this.url(path, opts.query);
    const res = await this.send("GET", url, {
      accept: opts.accept ?? "application/octet-stream",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProtectApiError(this.errorMessage(res, "GET", path, text), {
        status: res.status,
        path,
        errors: safeJsonParse(text),
      });
    }

    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
      throw new ProtectApiError(
        `${path} would return ${declared} bytes, over the ${this.maxDownloadBytes}-byte limit. ` +
          `Narrow the time range, or raise UNIFI_PROTECT_MAX_DOWNLOAD_BYTES.`,
        { status: res.status, path },
      );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > this.maxDownloadBytes) {
      throw new ProtectApiError(
        `${path} returned ${bytes.byteLength} bytes, over the ${this.maxDownloadBytes}-byte ` +
          `limit. Narrow the time range, or raise UNIFI_PROTECT_MAX_DOWNLOAD_BYTES.`,
        { status: res.status, path },
      );
    }

    return {
      bytes,
      contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  /** Status-aware prose, because this is the text someone acts on. */
  private errorMessage(res: Response, method: string, path: string, body: string): string {
    const detail = safeJsonParse(body);
    const upstream =
      typeof detail === "object" && detail !== null && "error" in detail
        ? String((detail as { error: unknown }).error)
        : typeof detail === "string" && detail.length > 0 && detail.length < 200
          ? detail
          : undefined;

    const base =
      `Protect ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim() +
      (upstream ? ` — ${upstream}` : "");

    if (res.status === 401 || res.status === 403) {
      return (
        `${base}. The account may lack Protect permissions for this device, or may be ` +
        `view-only while this call needs write access.`
      );
    }
    if (res.status === 404) {
      return (
        `${base}. Check the id came from a list tool on THIS console. Note also that the ` +
        `private Protect API is undocumented and Ubiquiti moves endpoints between releases — ` +
        `unifi_protect_get_system_info reports the version actually running.`
      );
    }
    // A redirect reaching here means `redirect: "manual"` caught a bounce to
    // the login page, which is what an expired or rejected session looks like.
    if (res.status >= 300 && res.status < 400) {
      return `${base}. The console redirected the request, which usually means the session was rejected.`;
    }
    return base;
  }
}
