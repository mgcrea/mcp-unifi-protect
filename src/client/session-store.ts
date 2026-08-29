import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A console session: the bare cookie value plus the CSRF token that was current
 * when it was issued. Both are needed on every request, and neither is derivable
 * from the other, so they are stored and invalidated as one unit.
 */
export type PersistedSession = {
  /** The `TOKEN=<jwt>` pair, attributes already stripped. */
  cookie: string;
  csrfToken: string;
  /** Which console this belongs to, so a changed host does not reuse a stale session. */
  baseUrl: string;
  /** Which account it was issued to, for the same reason. */
  username: string;
  savedAt: string;
};

/** Load a persisted session, or undefined if none / unreadable / not JSON. */
export const loadSession = async (path: string): Promise<PersistedSession | undefined> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    // A truncated or hand-edited file must read as "no session" rather than
    // producing a request with `cookie: undefined`, which fails as a 401 and
    // sends you looking at the password.
    if (!parsed.cookie || !parsed.csrfToken || !parsed.baseUrl || !parsed.username) {
      return undefined;
    }
    return parsed as PersistedSession;
  } catch {
    return undefined;
  }
};

/** Persist a session with owner-only permissions. */
export const saveSession = async (path: string, session: PersistedSession): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  // `mode` on writeFile only applies when the file is CREATED, so a session
  // rewritten over a file that already existed keeps whatever mode it had.
  // chmod every time rather than trusting the create bit.
  await chmod(path, 0o600);
};

/** Remove a persisted session. Absent is success — logout is idempotent. */
export const clearSession = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
};
