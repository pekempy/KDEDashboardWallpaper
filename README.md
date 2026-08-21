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
  (NZBget, qBittorrent-via-qui, Jellyfin, Immich) - gitignored, see
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
