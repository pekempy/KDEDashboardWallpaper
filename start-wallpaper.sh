#!/bin/bash

# GLaDOS Desktop Wallpaper Startup Script

CWD=$(cd "$(dirname "$0")" && pwd)

echo "=========================================="
# 1. Run KWin rule setup to ensure they are configured
python3 "$CWD/manage_kwin_rules.py"

# 2. Wait for the dashboard server to be available
echo "Checking if dashboard server (port 4848) is running..."
for i in {1..15}; do
    if curl -s -I http://localhost:4848 | grep -q "HTTP/1.1"; then
        echo "✓ Dashboard server is ready."
        break
    fi
    echo "Waiting for dashboard server to start (attempt $i/15)..."
    sleep 1
done

# 3. Kill any existing instances of the wallpaper window
echo "Cleaning up existing wallpaper window instances..."
pkill -f "aether_gui.py" || true
pkill -f "dashboard-wallpaper-profile" || true
sleep 1

# 4. Start Chrome in app mode with GPU acceleration and a dedicated profile
echo "Starting Google Chrome wallpaper window..."
google-chrome \
  --app=http://localhost:4848 \
  --class=dashboard-wallpaper \
  --user-data-dir="$HOME/.config/dashboard-wallpaper-profile" \
  --no-first-run \
  --no-default-browser-check \
  --enable-gpu-rasterization \
  --enable-zero-copy \
  --ignore-gpu-blocklist \
  --autoplay-policy=no-user-gesture-required \
  --password-store=basic \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  "$@" > /dev/null 2>&1 &

echo "Wallpaper window launched successfully in the background."
echo "=========================================="
