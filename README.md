# GLaDOS Desktop Dashboard

A minimal system HUD for KDE Plasma. Runs as a borderless background window
pinned beneath your active windows, showing just: system vitals, quick
terminal/update launchers, bookmarks, and folder shortcuts - plus a rotating
background image. Deliberately small (a corner HUD, not a full-screen
dashboard) so the wallpaper itself stays visible.

## Features

- **System Vitals**: CPU, RAM, and storage mount usage, live.
- **Terminal / Update**: one-click Konsole, and a one-click run of the
  `update` zshrc alias (apt + flatpak sweep).
- **Bookmarks & Folders**: quick launchers - folders open in Dolphin,
  bookmarks open in Zen Browser (Flatpak).
- **Search**: press `/` to search across bookmarks, folders, and running
  Docker containers at once - containers are queried live via `docker ps`
  (not persisted), and only ones with a published port show up, since
  those are the only ones with something to open in a browser.
- **Container Health**: widget surfaces any unhealthy/restarting containers
  (via `docker ps -a`). Each one has a logs button that opens a modal with
  its `docker logs` output (long lines wrap with a hanging indent instead of
  bleeding off the edge), plus an "Open Dockhand" shortcut in the widget
  header - see `dockhand.url` in `config.yaml.example`.
- **Now Playing**: live Jellyfin + Plex sessions, consolidated into one
  widget - poster with the viewer's avatar badged on the corner, a
  transcode/direct-play icon, and a progress bar. Click a row for a popout
  with full stream details (codecs, resolution, bitrate, device, and why a
  transcode is happening).
- **Random background**: click the image icon (or hit the API) to pull a new
  wallpaper from rclone; broadcasts live over SSE so the window updates
  without a reload.
- **Edit mode**: click the gear icon to add/edit bookmarks and folders
  in place.

## Project Structure

- `server.js`: Node.js backend - serves config, runs the Terminal/Update/
  folder-open commands, opens bookmark URLs, reports system stats, handles
  the background rotation.
- `public/`: HTML/CSS/JS frontend.
- `start-wallpaper.sh`: KWin rule setup + launches Chrome in app mode
  pointed at the server.
- `manage_kwin_rules.py`: registers the KWin window rules (pinned,
  borderless, non-minimizable).
- `config.yaml`: bookmarks, folder shortcuts, UI settings, the home directory
  used as the default working dir for command launches, the rclone
  remote/path for background rotation, and optional service integrations
  (NZBget, qBittorrent-via-qui, Jellyfin, Plex, Immich) - gitignored, see
  `config.yaml.example` for the shape. Each integration block is optional;
  omit one to disable that widget. `integrations` is stripped before the
  config is sent to the browser - only the server-side proxy endpoints see
  those credentials.
- `docker.yaml`, `public/background.jpg`: both gitignored. `docker.yaml` is
  leftover/unused local data; `background.jpg` is regenerated at runtime by
  the rclone background rotation, so a fresh clone starts with no background
  image until `background.rclone_remote` is configured and the wallpaper is
  rotated at least once.

## Setup & Run

1. **Install dependencies**: `npm install`
2. **Register the background window rules**: `python3 manage_kwin_rules.py`
3. **Start the wallpaper panel**: `./start-wallpaper.sh`

To make it apply on boot, the `dashboard-wallpaper.desktop` launcher in
`~/.config/autostart/` points at `start-wallpaper.sh`. The Node backend
itself runs 24/7 via the `glados-dashboard.service` systemd user unit
(installed by `setup-service.sh`) - `start-wallpaper.sh` just (re)launches
the Chrome window pointed at whatever the service is already serving.

**After editing `public/*` or `server.js`**, both `systemctl --user restart
glados-dashboard.service` (picks up server.js changes) *and* re-running
`start-wallpaper.sh` (relaunches the Chrome window so it actually reloads
the new HTML/CSS/JS - a running Chrome window doesn't pick up file changes
on its own) are needed to see the result.

## Public API

Everything this dashboard knows - system stats, now-playing, recently added
media (with poster/thumbnail URLs), active downloads, docker container
health - as one JSON blob at `GET /api/public/dashboard`, meant for an
external client (a phone-widget build of this same dashboard, say) to pull
over the internet and pick whatever fields it needs out of. One endpoint,
everything in it - filter client-side rather than asking for narrower ones.

**Off by default.** Copy `.env.example` to `.env` and set `PUBLIC_API_TOKEN`
(`openssl rand -hex 32` is a good way to generate one) - with it unset, the
entire `/api/public/*` namespace 404s as if it doesn't exist. `.env` is
gitignored; `server.js` loads it itself on startup (Node's
`process.loadEnvFile`, no extra dependency), so a `systemctl --user restart
glados-dashboard.service` after editing it is enough to pick it up.

Send the token either as `Authorization: Bearer <token>` or `?token=<token>`
on every request under `/api/public/`. Wrong or missing token → 401; no
token configured at all → 404.

Poster/thumbnail URLs in the response (`thumbUrl`, `posterUrl`,
`user.avatarUrl`) are relative paths already rewritten to their
`/api/public/media/...` mirror (same auth as everything else under
`/api/public/`) - resolve them against whatever host you're reverse-proxying
this through, e.g. `https://dashboard.example.com` + `/api/public/media/thumb/jellyfin/abc123`.

**Only read-only, stats-shaped routes live under `/api/public/`.** The
command/URL-launch, config-write, and docker-logs endpoints stay
local-network-only regardless of this token - don't add them to this
namespace.

**Exposing it externally (Caddy):** point a Caddy site block's
`reverse_proxy` at *only* the `/api/public/*` path on this host (not the
whole app - everything else here has no auth) - and since this runs on the
host, not in a container, Caddy needs `extra_hosts:
["host.docker.internal:host-gateway"]` on its own compose service to reach
it. See `config.yaml`'s `server.host: 0.0.0.0` - the app already listens on
all interfaces, so this is purely a Caddy/network-reachability step, not an
app change.
