# @mgcrea/mcp-unifi-protect

Model Context Protocol server for a self-hosted **UniFi Protect** console — cameras, recorded
events and smart detections, snapshots, footage export, and the lights, sensors, viewers and
chimes attached to it. Read-only by default: the tools that change anything are not registered
at all unless you ask for them.

## Features

- **Search recorded events over any time range** — motion, person / vehicle / animal / package /
  licence-plate detections, doorbell rings — with each result already carrying its camera's
  **name**, not just an id.
- **Snapshots and footage** — capture a frame now, pull an event's thumbnail, export an MP4.
  All written to disk by default, so a still frame does not silently cost you a context window.
- **Devices** — cameras, lights, sensors (with their temperature, humidity and light readings),
  viewers, chimes, live views and users.
- **Shaped responses.** A console camera record is 8-15 KB of JSON; a list of ten is over 100 KB.
  List tools return the fifteen fields anyone actually asks about. `get_*` returns everything.
- **Stays up with no credentials**, reporting what to configure through `unifi_protect_auth_status`
  rather than exiting and showing in your client as a bare `Connection closed`.

## Security

**Supply chain.** Two runtime dependencies: the MCP SDK and zod. HTTP is native `fetch` with a
hand-rolled retry; there is no HTTP client, no logger, no crypto library. Published from CI with
provenance via OIDC trusted publishing; the container image is multi-arch, carries an SBOM, and
is signed with cosign.

**Your credentials.** The username and password come from the environment or a config file, and
never leave this process except in the login request to your console. The resulting session
cookie is cached at `~/.config/unifi-protect/session.json` with mode `600`.

**Certificate verification is OFF by default.** Consoles present a self-signed certificate and
you reach them by IP, so neither chain trust nor hostname verification can succeed. Node bundles
undici but does not expose it, so `fetch` cannot take a per-request dispatcher — which means
there is no way to scope this to one host without adding a runtime dependency. It is therefore
disabled **process-wide**, which is acceptable only because this process talks to exactly one
host: your console. The startup banner prints `tls=UNVERIFIED` on every run.

**Blast radius.** With the defaults, the worst an agent can do is read your cameras and write
image files into the snapshot directory. With `UNIFI_PROTECT_ALLOW_WRITES=1` it can additionally
reconfigure devices, move PTZ cameras, stop a camera recording, and reboot a camera or the whole
console. Use a Local-Access-Only account with View Only rights and leave writes off unless you
need them.

## Configure

| Variable                           | Required | Default                                | What it does                                                  |
| ---------------------------------- | -------- | -------------------------------------- | ------------------------------------------------------------- |
| `UNIFI_PROTECT_HOST`               | yes      | —                                      | Console IP or hostname. `https://` assumed, `:port` preserved |
| `UNIFI_PROTECT_USERNAME`           | yes      | —                                      | Console login                                                 |
| `UNIFI_PROTECT_PASSWORD`           | yes      | —                                      | Its password                                                  |
| `UNIFI_PROTECT_TOTP`               | no       | —                                      | 2FA code. Expires in ~30s — prefer `unifi_protect_auth_login` |
| `UNIFI_PROTECT_VERIFY_TLS`         | no       | `false`                                | Verify the console's certificate                              |
| `UNIFI_PROTECT_ALLOW_WRITES`       | no       | `false`                                | Register the 12 mutating tools                                |
| `UNIFI_PROTECT_SESSION_FILE`       | no       | `~/.config/unifi-protect/session.json` | Cached session, mode 600                                      |
| `UNIFI_PROTECT_SNAPSHOT_DIR`       | no       | `~/.cache/unifi-protect`               | Where images and exports are written                          |
| `UNIFI_PROTECT_CONFIG`             | no       | `~/.config/unifi-protect/config.json`  | Config file location                                          |
| `UNIFI_PROTECT_MAX_RETRIES`        | no       | `3`                                    | Retries on 401 / 429 / 5xx                                    |
| `UNIFI_PROTECT_MAX_DOWNLOAD_BYTES` | no       | `200000000`                            | Refuse a download larger than this                            |
| `UNIFI_PROTECT_DEVICE_CACHE_TTL`   | no       | `60`                                   | Camera id→name cache lifetime, seconds                        |
| `UNIFI_PROTECT_DEBUG`              | no       | —                                      | Verbose request logging to stderr                             |

The config file mirrors these as camelCase JSON (`host`, `username`, `verifyTls`, …). It is
strict: an unknown key is an error rather than a silent no-op. **Environment variables win over
the file, field by field**, so a one-off `UNIFI_PROTECT_ALLOW_WRITES=0` still beats a file that
says `true`.

### Create an account for it

UniFi OS → **Settings → Admins & Users → Add User → Local Access Only**, with Protect
permissions and **View Only** unless you plan to enable writes.

Use a local account rather than your Ubiquiti (SSO) one. Cloud accounts frequently cannot log in
locally at all, and a scoped local account keeps this server away from the rest of the console.

## Quick start

**A. npx**

```bash
UNIFI_PROTECT_HOST=192.168.1.1 UNIFI_PROTECT_USERNAME=mcp UNIFI_PROTECT_PASSWORD=… \
  npx -y @mgcrea/mcp-unifi-protect
```

**B. Docker (stdio)**

```bash
docker run --rm -i \
  -e UNIFI_PROTECT_HOST=192.168.1.1 \
  -e UNIFI_PROTECT_USERNAME=mcp \
  -e UNIFI_PROTECT_PASSWORD=… \
  ghcr.io/mgcrea/mcp-unifi-protect
```

**C. From source**

```bash
pnpm install && pnpm build
node dist/cli.js
```

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Tools

20 read tools, plus 9 more when writes are enabled.

| Tool                                              | What it does                                                                                        | Writes                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| `unifi_protect_auth_status`                       | Log in and make a real call, reporting whether the console is reachable and on what Protect version | —                      |
| `unifi_protect_auth_login`                        | Force a fresh login; the only way to supply a 2FA code                                              | —                      |
| `unifi_protect_auth_logout`                       | Drop the cached session and delete the session file                                                 | confirm                |
| `unifi_protect_get_system_info`                   | Console model, Protect version, storage, device counts                                              | —                      |
| `unifi_protect_list_cameras`                      | Every camera, summarized                                                                            | —                      |
| `unifi_protect_get_camera`                        | One camera's complete record (large)                                                                | —                      |
| `unifi_protect_get_camera_snapshot`               | Capture a frame now, to a file or inline                                                            | —                      |
| `unifi_protect_list_events`                       | **Search recorded events over any time range**                                                      | —                      |
| `unifi_protect_get_event`                         | One event's full detection metadata                                                                 | —                      |
| `unifi_protect_get_event_thumbnail`               | The frame that triggered a detection                                                                | —                      |
| `unifi_protect_export_video`                      | Export footage as an MP4 on disk                                                                    | —                      |
| `unifi_protect_list_lights`                       | Floodlights, with state and brightness                                                              | —                      |
| `unifi_protect_list_sensors`                      | Sensors, with temperature / humidity / light readings                                               | —                      |
| `unifi_protect_list_viewers`                      | Viewport devices and what each displays                                                             | —                      |
| `unifi_protect_list_chimes`                       | Chimes, volume, paired doorbells                                                                    | —                      |
| `unifi_protect_list_liveviews`                    | Saved camera grid layouts                                                                           | —                      |
| `unifi_protect_list_users`                        | Who can sign in to Protect                                                                          | —                      |
| `unifi_protect_request`                           | Escape hatch: call any private endpoint directly                                                    | GET only unless writes |
| `unifi_protect_update_camera`                     | Name, mic, LED, OSD                                                                                 | ✅                     |
| `unifi_protect_set_camera_recording_mode`         | `always` / `never` / `detections` / `schedule`                                                      | ✅                     |
| `unifi_protect_ptz_goto_preset`                   | Point a PTZ camera at a preset                                                                      | ✅                     |
| `unifi_protect_ptz_start_patrol` / `_stop_patrol` | Start / stop a patrol route                                                                         | ✅                     |
| `unifi_protect_reboot_camera`                     | Reboot one camera                                                                                   | ✅ confirm             |
| `unifi_protect_update_light`                      | Brightness, on/off, PIR sensitivity                                                                 | ✅                     |
| `unifi_protect_update_sensor`                     | Name, which capabilities report                                                                     | ✅                     |
| `unifi_protect_update_viewer`                     | Put a live view on a screen                                                                         | ✅                     |
| `unifi_protect_update_chime`                      | Volume, name                                                                                        | ✅                     |
| `unifi_protect_update_nvr_settings`               | Console name, timezone, global recording                                                            | ✅                     |
| `unifi_protect_reboot_nvr`                        | Reboot the console                                                                                  | ✅ confirm             |

## Worked example: what happened at the front door last night

```jsonc
// 1. Which cameras are there?
{"name": "unifi_protect_list_cameras", "arguments": {}}
// → [{ "id": "661a…", "name": "Front Door", "hasSmartDetect": true,
//      "smartDetectTypes": ["person","package"], "recordingMode": "detections", … }]

// 2. People seen overnight. Note the camera NAME comes back resolved.
{"name": "unifi_protect_list_events", "arguments": {
   "start": "2026-08-29T22:00:00Z", "end": "2026-08-30T07:00:00Z",
   "types": ["smartDetectZone"], "smartDetectTypes": ["person"]}}
// → { "count": 3, "events": [
//     { "id": "9f3c1a02-…", "start": "2026-08-30T02:14:07.000Z", "camera": "Front Door",
//       "smartDetectTypes": ["person"], "score": 94, "hasThumbnail": true }, … ] }

// 3. Look at the one at 02:14 — pass the event's own id.
{"name": "unifi_protect_get_event_thumbnail",
 "arguments": {"eventId": "9f3c1a02-…", "output": "image"}}

// 4. Pull the footage around it.
{"name": "unifi_protect_export_video", "arguments": {
   "cameraId": "661a…", "start": "2026-08-30T02:13:30Z", "end": "2026-08-30T02:15:00Z"}}
// → { "path": "/Users/you/.cache/unifi-protect/front-door-….mp4", "bytes": 18432000 }
```

## Traps worth knowing

**This wraps Protect's private API, not the official one.** Ubiquiti publishes an Integration
API at `/proxy/protect/integration/v1` with an OpenAPI spec and an `X-API-KEY` header. It is not
used here, because it has **no historical query capability at all** — the only query parameters
in its entire spec are `channel`, `highQuality` and `qualities`, and events exist solely as a
live WebSocket. "What happened last night" is unanswerable through it. The private API answers
that, at the cost of being undocumented and liable to change between Protect releases. This was
built and verified end-to-end against a live **UNVR running Protect 7.2.105**.
`unifi_protect_get_system_info` reports the version you are actually running, and
`unifi_protect_request` reaches any endpoint that moves.

Two shapes already changed between 6.x and 7.x, both found by running this against a real
console, and both now handled in either form:

- **Storage moved.** 6.x had `nvr.storageInfo` with `totalSize` / `totalSpaceUsed`. By 7.2 that
  key is gone; the numbers live under `nvr.systemInfo.storage` and `nvr.storageStats`, with
  per-disk health in `systemInfo.ustorage.disks`.
- **A camera has no `ledLevel`.** The 0-6 brightness that looks like it belongs there is a
  _floodlight_ field; a camera's LED is the on/off `ledSettings.isEnabled`. Sub-objects also
  deep-merge on PATCH, so setting one OSD overlay preserves the others — verified by writing to
  a live camera and reading it back.
- **An event's `thumbnail` field is not a thumbnail id you can use here.** It reads `e-<eventId>`
  and belongs to the `thumbnails/<id>` endpoint; `events/<eventId>/thumbnail` — the one this
  server calls — wants the bare event id. Passing the console's own value returns 404. So list
  results report `hasThumbnail: true` rather than an id, and `unifi_protect_get_event_thumbnail`
  takes the event's `id` (though it tolerates an `e-…` value too).

**Times are milliseconds, and getting it wrong fails silently.** The console takes JavaScript
millisecond timestamps. A Unix _seconds_ value is not rejected — it is read as a moment in 1970,
so the query succeeds and returns an empty list, which reads as "nothing happened". Every time
argument here accepts ISO 8601, a relative expression (`"2h ago"`, `"30m"`, `"7d"`) or `"now"`,
and a ten-digit number is refused with the corrected value in the error.

**Event search is always filtered by type.** Omitting `types` entirely triggers a pagination bug
in Protect where the console ignores the window and returns the wrong slice. `unifi_protect_list_events`
always sends an explicit list, defaulting to motion, smart detections and rings.

**Footage only exists if the camera was recording.** An empty event search may mean the camera's
recording mode is `never`, not that nothing happened. `unifi_protect_list_cameras` shows the mode.

**Snapshots are forced.** Without that the console can return a cached frame minutes old, which
is indistinguishable from a current one.

**A cloud account may not work.** Ubiquiti SSO accounts frequently cannot log in locally. Create
a Local Access Only user.

## Troubleshooting

**The server does not appear, or shows `Connection closed`.** It should never exit on missing
credentials — run it by hand with the same environment and read stderr. Everything it logs goes
to stderr, because stdout is the protocol channel.

**Only `unifi_protect_auth_status` is listed.** No console is configured. Call that tool; it
returns the setup steps as data.

**A tool I expected is missing.** The write tools are not registered unless
`UNIFI_PROTECT_ALLOW_WRITES=1`. That is the design, not a bug — an absent tool cannot be called,
whereas a refused one invites an agent to keep trying.

**`self-signed certificate` errors.** `UNIFI_PROTECT_VERIFY_TLS` must be `false` (the default)
unless you have installed a trusted certificate on the console.

**Everything returns 401.** Check the account is a local one, and that it has Protect
permissions. `unifi_protect_auth_status` distinguishes "cannot log in" from "logged in but
forbidden".

**A tool that used to work now returns 404.** Compare the Protect version from
`unifi_protect_get_system_info` against 7.2.105 above; an upgrade may have moved the endpoint.
`unifi_protect_request` is the workaround while it is fixed — it reaches any path under
`/proxy/protect/api` directly, which is how both of the 6.x→7.x changes above were pinned down.

**Storage shows as nearly full.** That is normal on an NVR: `isRecycling: true` means the
console continuously overwrites the oldest footage rather than stopping. `get_system_info` says
so inline so it does not read as a fault.

## Not implemented

The realtime WebSocket at `/proxy/protect/ws/updates` is not wired up. It is a binary framed
protocol, and because this server wraps the private API, event _history_ is already available
over REST through `unifi_protect_list_events` — which is what the WebSocket would have been
needed for. Node's global `WebSocket` follows the WHATWG signature and ignores a headers option,
so attaching the session cookie would mean adding `ws` as a dependency.

## Develop

```bash
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Publish:

```bash
pnpm dlx release-it            # bump, commit, tag
git push --follow-tags         # CI publishes to npm + GHCR from the tag
```

## License

MIT
