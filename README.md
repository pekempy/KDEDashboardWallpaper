# GLaDOS Desktop Dashboard

A high-performance system dashboard for KDE Plasma. Designed as a borderless background utility window, it stays fixed below your active windows and monitors folders, bookmarks, system hardware, projects, and Docker containers in real-time.

## Features

- **System Monitor**: CPU, RAM, and multiple storage mount paths (e.g., MergerFS pools) monitored live.
- **Project & Docker Grid**: Launch local developer scripts, check git status, start/stop docker containers, and stream container logs in real-time.
- **Shortcuts & Bookmarks**: Fast access to Dolphin folders and external links (launching directly in Flatpak Zen Browser).
- **Responsive Layout**: Support for category filters and a toggleable Compact Mode (dense layout for large screen spaces).
- **Persistent KWin Rules**: Configured to stay pinned beneath windows as a non‑minimizable, borderless background app.
- **Live Console Streaming**: Actions now run via `/api/action/stream` and output appears in a slide‑out terminal drawer.
- **Progress‑Bar Rendering**: Server buffers partial lines and handles carriage‑return (`\r`) updates for tqdm‑style bars.

## Project Structure

- `server.js`: Node.js backend managing local file configs, executing bash scripts/actions, querying docker states, and collecting system resources.
- `public/`: HTML/CSS/JS frontend assets.
- `start-wallpaper.sh`: Runs KWin configuration checks and boots Chrome in a dedicated app profile.
- `manage_kwin_rules.py`: Automated Python script to register KWin window rules.
- `config.yaml` / `projects.yaml`: Main user configuration files.

## Setup & Run

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Register the background window rules**:
   ```bash
   python3 manage_kwin_rules.py
   ```

3. **Start the wallpaper panel**:
   ```bash
   ./start-wallpaper.sh
   ```

To make it apply on boot, the `dashboard-wallpaper.desktop` launcher in `~/.config/autostart/` points directly to `start-wallpaper.sh`.
